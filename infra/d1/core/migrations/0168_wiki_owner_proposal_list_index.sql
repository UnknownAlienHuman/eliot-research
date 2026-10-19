-- Owner Inbox lists are a direct bounded metadata query.  This index matches
-- the owner filter and stable newest-first order without replaying proposal scope.
CREATE INDEX IF NOT EXISTS idx_wiki_publication_proposal_owner_created
ON wiki_publication_proposal(principal_ref, created_at DESC, proposal_id DESC);
