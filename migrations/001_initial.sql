CREATE TABLE trades (
 trade_id VARCHAR(40) PRIMARY KEY,
 client VARCHAR(100) NOT NULL,
 symbol VARCHAR(20) NOT NULL,
 quantity INTEGER NOT NULL CHECK (quantity > 0),
 price NUMERIC(14,2) NOT NULL CHECK (price > 0),
 timestamp TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX trades_timestamp_idx ON trades (timestamp DESC, trade_id DESC);
CREATE INDEX trades_symbol_idx ON trades (symbol, timestamp DESC, trade_id DESC);
CREATE INDEX trades_client_idx ON trades (client);
CREATE TABLE extraction_jobs (
 job_id UUID PRIMARY KEY,
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
 filters JSONB NOT NULL,
 delay_ms INTEGER NOT NULL CHECK (delay_ms BETWEEN 0 AND 900000),
 ready_at TIMESTAMPTZ NOT NULL,
 total_records INTEGER NOT NULL DEFAULT 0,
 error TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 started_at TIMESTAMPTZ,
 completed_at TIMESTAMPTZ
);
CREATE TABLE extraction_results (
 job_id UUID NOT NULL REFERENCES extraction_jobs(job_id) ON DELETE CASCADE,
 trade_id VARCHAR(40) NOT NULL,
 client VARCHAR(100) NOT NULL,
 symbol VARCHAR(20) NOT NULL,
 quantity INTEGER NOT NULL,
 price NUMERIC(14,2) NOT NULL,
 timestamp TIMESTAMPTZ NOT NULL,
 PRIMARY KEY (job_id, trade_id)
);
CREATE INDEX extraction_results_page_idx ON extraction_results (job_id, timestamp DESC, trade_id DESC);
