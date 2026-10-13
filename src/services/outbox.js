const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const config = require('../config');
const { ApiError } = require('../errors');
const { destination } = require('../webhook-validation');
const { send, retryDelay } = require('./webhook-http');

class Outbox extends EventEmitter {
    constructor(db, options = config.webhook) {
        super(); this.db = db; this.options = options; this.active = false;
        this.timers = new Map(); this.scheduled = new Set(); this.inflight = new Map(); this.tasks = new Set();
        this.paused = false; this.buffered = new Set();
    }
    track(promise) {
        const task = promise.catch(() => {
            this.active = false;
            this.emit('fatal', new Error('Cannot persist notification state; restart required'));
        });
        this.tasks.add(task); task.then(() => this.tasks.delete(task));
    }
    async start({ deferDelivery = false } = {}) {
        // Called only after the extraction worker owns the schema session lock.
        await this.db.query(`UPDATE extraction_outbox SET
            state=CASE WHEN cycle_attempts >= $1 THEN 'exhausted' ELSE 'retry' END,
            claim_id=NULL, next_attempt_at=NOW(), last_error='DELIVERY_INTERRUPTED', updated_at=NOW()
            WHERE state='delivering'`, [this.options.maxAttempts]);
        await this.db.query("UPDATE extraction_outbox SET state='exhausted', updated_at=NOW() WHERE state IN ('pending','retry') AND cycle_attempts >= $1", [this.options.maxAttempts]);
        const { rows } = await this.db.query("SELECT job_id FROM extraction_outbox WHERE state IN ('pending','retry')");
        this.active = true;
        this.paused = deferDelivery;
        for (const row of rows) this.wake(row.job_id);
    }
    resume() {
        this.paused = false;
        const ids = [...this.buffered]; this.buffered.clear();
        for (const id of ids) this.wake(id);
    }
    wake(id) {
        if (this.active && this.paused) { this.buffered.add(id); return; }
        if (!this.active || this.scheduled.has(id) || this.inflight.has(id)) return;
        this.scheduled.add(id);
        this.track((async () => {
            const { rows } = await this.db.query("SELECT next_attempt_at FROM extraction_outbox WHERE job_id=$1 AND state IN ('pending','retry')", [id]);
            if (!this.active || !rows.length) { this.scheduled.delete(id); return; }
            const timer = setTimeout(() => {
                this.timers.delete(id); this.scheduled.delete(id);
                if (this.active) this.track(this.deliver(id));
            }, Math.max(0, Date.parse(rows[0].next_attempt_at) - Date.now()));
            this.timers.set(id, timer);
        })());
    }
    async deliver(id) {
        if (!this.active || this.inflight.has(id)) return;
        const abort = new AbortController(); this.inflight.set(id, abort);
        let retry = false;
        try {
            const claim = randomUUID();
            const { rows } = await this.db.query(`UPDATE extraction_outbox SET state='delivering',
                attempts=attempts+1, cycle_attempts=cycle_attempts+1, claim_id=$2,
                next_attempt_at=NOW()+($3::integer*INTERVAL '1 millisecond'), updated_at=NOW()
                WHERE job_id=$1 AND state IN ('pending','retry') AND next_attempt_at <= NOW() AND cycle_attempts < $4
                RETURNING *`, [id, claim, this.options.timeoutMs + 5000, this.options.maxAttempts]);
            if (!rows.length) { retry = true; return; }
            const event = rows[0];
            const registration = await this.db.query('SELECT callback_url, client_job_id FROM extraction_jobs WHERE job_id=$1', [id]);
            let result;
            try {
                const url = new URL(destination(registration.rows[0].callback_url, this.options));
                if (!this.options.secret || this.options.secret.length < 32) result = { error: 'WEBHOOK_NOT_CONFIGURED', retryable: false };
                else result = await send(url, { externalJobId: id, clientJobId: registration.rows[0].client_job_id, status: event.terminal_status }, this.options, abort.signal);
            } catch { result = { error: 'CALLBACK_DESTINATION_REJECTED', retryable: false }; }
            const state = result.acknowledged ? 'delivered' : !result.retryable ? 'permanent_failure' : event.cycle_attempts >= this.options.maxAttempts ? 'exhausted' : 'retry';
            const delay = retryDelay(event.cycle_attempts, result.retryAfter, this.options);
            await this.db.query(`UPDATE extraction_outbox SET state=$3, claim_id=NULL,
                last_error=$4, last_http_status=$5, next_attempt_at=NOW()+($6::integer*INTERVAL '1 millisecond'),
                delivered_at=CASE WHEN $3='delivered' THEN NOW() ELSE delivered_at END, updated_at=NOW()
                WHERE job_id=$1 AND claim_id=$2 AND state='delivering'`,
                [id, claim, state, result.error || null, result.status || null, delay]);
            retry = state === 'retry';
        } finally {
            this.inflight.delete(id);
            if (retry && this.active) this.wake(id);
        }
    }
    async get(id) {
        const { rows } = await this.db.query(`SELECT job_id,terminal_status,state,attempts,cycle_attempts,next_attempt_at,
            last_error,last_http_status,created_at,updated_at,delivered_at FROM extraction_outbox WHERE job_id=$1`, [id]);
        if (!rows.length) throw new ApiError(404, 'NOTIFICATION_NOT_FOUND', 'No terminal callback notification exists for this job');
        return rows[0];
    }
    async redeliver(id) {
        if (!this.active) throw new ApiError(503, 'WORKER_UNAVAILABLE', 'Notification worker unavailable');
        const { rows } = await this.db.query(`UPDATE extraction_outbox SET state='pending',cycle_attempts=0,
            next_attempt_at=NOW(),last_error=NULL,last_http_status=NULL,updated_at=NOW()
            WHERE job_id=$1 AND state IN ('delivered','permanent_failure','exhausted') RETURNING job_id`, [id]);
        if (!rows.length) { await this.get(id); throw new ApiError(409, 'NOTIFICATION_ACTIVE', 'Notification delivery is already pending or active'); }
        this.wake(id);
        return { jobId: id, state: 'pending' };
    }
    async stop() {
        this.active = false;
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear(); this.scheduled.clear();
        this.buffered.clear();
        for (const abort of this.inflight.values()) abort.abort();
        await Promise.allSettled([...this.tasks]);
    }
}
module.exports = Outbox;
