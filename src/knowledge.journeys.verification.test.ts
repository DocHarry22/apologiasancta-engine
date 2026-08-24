import assert from "node:assert/strict";
import test from "node:test";
import { KnowledgeInputError } from "./knowledge/validation";
import { validateArgumentDraft, validatePathDraft, validateTopicDraft } from "./knowledge/journeys";

test("journey validators accept bounded canonical topic/path/argument drafts", () => {
  const topic = validateTopicDraft({
    id: "topic:trinity",
    title: "The Trinity",
    rootNodeId: "claim:one-god-three-persons",
    featuredNodeIds: ["scripture:matthew-28-19"],
  });
  assert.equal(topic.rootNodeId, "claim:one-god-three-persons");

  const path = validatePathDraft({
    id: "path:trinity-guided",
    title: "Trinity guided path",
    pathType: "guided",
    steps: [{ nodeId: "claim:one-god-three-persons" }],
  });
  assert.equal(path.steps.length, 1);

  const argument = validateArgumentDraft({
    id: "argument:trinity-case",
    title: "Trinity case",
    argumentType: "doctrinal",
    conclusionNodeId: "claim:one-god-three-persons",
    members: [{ nodeId: "scripture:matthew-28-19", role: "evidence" }],
  });
  assert.equal(argument.members[0]?.role, "evidence");
});

test("journey validators reject direct publication and invalid path/argument vocabularies", () => {
  assert.throws(
    () => validateTopicDraft({ title: "T", rootNodeId: "claim:a", contentState: "published" }),
    KnowledgeInputError
  );
  assert.throws(
    () => validatePathDraft({ title: "P", pathType: "secret", steps: [{ nodeId: "claim:a" }] }),
    /unsupported pathType/
  );
  assert.throws(
    () => validatePathDraft({ title: "P", pathType: "guided", steps: [] }),
    /at least one step/
  );
  assert.throws(
    () => validateArgumentDraft({ title: "A", argumentType: "magic", conclusionNodeId: "claim:a" }),
    /unsupported argumentType/
  );
  assert.throws(
    () => validateArgumentDraft({
      title: "A",
      argumentType: "textual",
      conclusionNodeId: "claim:a",
      members: [{ nodeId: "claim:b", role: "truth_score" }],
    }),
    /unsupported argument member role/
  );
});
