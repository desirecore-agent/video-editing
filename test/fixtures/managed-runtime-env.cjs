// Synthetic consistency inputs for unit processes, not platform authorization
// or native acceptance evidence. Client values come from that test's server.
const platform = {
  DESIRECORE_APP_RUNTIME_PROOF: "unit-runtime-proof",
  DESIRECORE_APP_SCOPE_ID: "unit-installation",
  DESIRECORE_APP_RUNTIME_GENERATION: "unit-generation",
  DESIRECORE_APP_RELEASE_DIGEST: "unit-release",
};
function client(owner) {
  return {
    FABLECUT_MANAGED:"1", FABLECUT_NO_AUTOSTART:"1",
    FABLECUT_EXPECTED_INSTANCE_ID:owner.instanceId,
    FABLECUT_EXPECTED_SCOPE_ID:owner.scopeId,
    FABLECUT_EXPECTED_RUNTIME_GENERATION:owner.runtimeGeneration,
    FABLECUT_EXPECTED_RELEASE_DIGEST:owner.releaseDigest,
  };
}
module.exports = {platform,client};
