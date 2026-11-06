-- Stable published-page inventory; head/freshness updates do not move its cursor.
CREATE INDEX page_by_created ON page(project_id,created_at DESC,id DESC) WHERE head_revision_id IS NOT NULL;
