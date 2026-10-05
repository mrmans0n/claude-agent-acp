import { compareVersions } from "./verify-upstream-release.mjs";

const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function selectUpstreamSync({ tags, packageVersion, openHeads }) {
  const stable = tags
    .map((tag) => (typeof tag === "string" ? { name: tag } : tag))
    .filter(
      (tag) => STABLE_TAG.test(tag.name) && compareVersions(tag.name.slice(1), packageVersion) > 0,
    )
    .sort((a, b) => compareVersions(b.name.slice(1), a.name.slice(1)));
  const newest = stable[0];
  if (!newest) return null;
  const branch = `sync/upstream-${newest.name.slice(1)}`;
  return {
    tag: newest.name,
    branch,
    staleHeads: [...new Set(openHeads)].filter(
      (head) =>
        head !== branch &&
        STABLE_TAG.test(head.replace(/^sync\/upstream-/, "v")) &&
        head.startsWith("sync/upstream-"),
    ),
  };
}
