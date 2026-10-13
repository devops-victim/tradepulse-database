ALTER TABLE extraction_jobs
 ADD COLUMN callback_url TEXT,
 ADD COLUMN client_job_id UUID,
 ADD COLUMN idempotency_key VARCHAR(200) UNIQUE,
 ADD COLUMN request_fingerprint CHAR(64),
 ADD CONSTRAINT callback_registration_pair CHECK ((callback_url IS NULL) = (client_job_id IS NULL)),
 ADD CONSTRAINT idempotency_fingerprint_pair CHECK ((idempotency_key IS NULL) = (request_fingerprint IS NULL));

CREATE TABLE extraction_outbox (
 job_id UUID NOT NULL REFERENCES extraction_jobs(job_id) ON DELETE CASCADE,
 terminal_status TEXT NOT NULL CHECK (terminal_status IN ('completed','failed')),
 state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivering','retry','delivered','permanent_failure','exhausted')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 cycle_attempts INTEGER NOT NULL DEFAULT 0 CHECK (cycle_attempts >= 0),
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 claim_id UUID,
 last_error VARCHAR(256),
 last_http_status INTEGER,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 delivered_at TIMESTAMPTZ,
 PRIMARY KEY (job_id, terminal_status)
);
CREATE INDEX extraction_outbox_unfinished_idx ON extraction_outbox (next_attempt_at)
 WHERE state IN ('pending','retry','delivering');
