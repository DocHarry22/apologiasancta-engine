export function boundedInteger(raw, fallback, min, max) {
  const value = Number(raw);
  return raw !== null && raw !== "" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.trunc(value))) : fallback;
}

// Metadata belongs to content authors; its keys are not database columns.
export function publicPayload(value) {
  if (Array.isArray(value)) return value.map(publicPayload);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (["current_snapshot", "published_snapshot", "created_by", "updated_by"].includes(key)) continue;
    const name = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    result[name] = key === "metadata" ? entry : publicPayload(entry);
  }
  if (value.published_revision_id) {
    result.currentRevisionId = value.published_revision_id;
    result.contentState = "published";
  }
  return result;
}

// Bounded breadth-first traversal: cycles are deduplicated and unpublished
// endpoints never enter the frontier. The adapter fetches each frontier in bulk.
export async function neighborhood(root, depth, limit, fetchEdges, fetchNodes) {
  const nodes = new Map([[root.id, root]]);
  const edges = new Map();
  let frontier = [root.id];
  for (let level = 0; level < depth && frontier.length && nodes.size < limit; level++) {
    const candidates = await fetchEdges(frontier, limit * 3);
    const ids = [...new Set(candidates.flatMap(edge => [edge.from_node_id, edge.to_node_id]))]
      .filter(id => !nodes.has(id)).sort().slice(0, limit * 6);
    const next = [];
    if (ids.length) {
      for (const node of await fetchNodes(ids)) {
        if (nodes.size >= limit) break;
        if (!nodes.has(node.id)) { nodes.set(node.id, node); next.push(node.id); }
      }
    }
    for (const edge of candidates) {
      if (edges.size >= limit * 3) break;
      if (nodes.has(edge.from_node_id) && nodes.has(edge.to_node_id)) edges.set(edge.id, edge);
    }
    frontier = next;
  }
  return { rootNodeId: root.id, depth, nodes: [...nodes.values()], edges: [...edges.values()] };
}
