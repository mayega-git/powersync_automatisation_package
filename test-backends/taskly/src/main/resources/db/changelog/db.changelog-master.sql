--liquibase formatted sql

--changeset taskly:001-schema
CREATE TABLE board (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    created_by uuid NOT NULL,
    name text NOT NULL,
    colour text NOT NULL,
    archived boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL
);
CREATE INDEX board_workspace_idx ON board (workspace_id);

CREATE TABLE task (
    id uuid PRIMARY KEY,
    board_id uuid NOT NULL REFERENCES board (id),
    title text NOT NULL,
    state text NOT NULL,
    position integer,
    assignee_id uuid,
    created_at timestamptz NOT NULL,
    completed_at timestamptz
);
CREATE INDEX task_board_idx ON task (board_id);

CREATE TABLE label (
    id uuid PRIMARY KEY,
    code text NOT NULL UNIQUE,
    title text NOT NULL,
    rank integer NOT NULL
);

CREATE TABLE activity_entry (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    member_id uuid NOT NULL,
    action text NOT NULL,
    subject_id uuid,
    trace_id text,
    caller_ip text
);
--rollback DROP TABLE activity_entry; DROP TABLE label; DROP TABLE task; DROP TABLE board;

--changeset taskly:002-reference-labels
INSERT INTO label (id, code, title, rank) VALUES
    ('00000000-0000-4000-8000-000000000001', 'URGENT', 'Urgent', 1),
    ('00000000-0000-4000-8000-000000000002', 'BUG',    'Bug',    2),
    ('00000000-0000-4000-8000-000000000003', 'CHORE',  'Chore',  3);
--rollback DELETE FROM label;

--changeset taskly:003-board-version
ALTER TABLE board ADD COLUMN version bigint;
--rollback ALTER TABLE board DROP COLUMN version;

--changeset taskly:004-activity-version
ALTER TABLE activity_entry ADD COLUMN version bigint;
--rollback ALTER TABLE activity_entry DROP COLUMN version;

--changeset taskly:005-idempotency
CREATE TABLE idempotency_entry (
    key text PRIMARY KEY,
    status integer NOT NULL,
    body text
);
--rollback DROP TABLE idempotency_entry;
