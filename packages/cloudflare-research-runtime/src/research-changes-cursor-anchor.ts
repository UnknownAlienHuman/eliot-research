import { CatalogInputError } from "@eliotr/cloudflare-navigation";
import type { ResearchChangesScanAnchor } from "./research-changes-scan.js";

/** Both legacy public and confidential scan positions must still have their exact immutable D1 anchor. */
export async function requireResearchChangesCursorAnchor(
  database: D1Database,
  position: ResearchChangesScanAnchor,
): Promise<void> {
  let anchor: ResearchChangesScanAnchor | null;
  try {
    anchor = await database.prepare(
      "SELECT sequence,change_ref FROM research_change_feed WHERE sequence=?1 LIMIT 1",
    ).bind(position.sequence).first<ResearchChangesScanAnchor>();
  } catch {
    throw new CatalogInputError("RESEARCH_CHANGES_SETTLEMENT_UNCERTAIN", "changes cursor readback is unavailable", 503, true);
  }
  if (anchor === null || anchor.sequence !== position.sequence || anchor.change_ref !== position.change_ref) {
    throw new CatalogInputError("RESEARCH_CHANGES_CURSOR_STALE", "changes cursor anchor no longer exists", 409);
  }
}
