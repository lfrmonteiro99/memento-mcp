import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";
import {
  toCompressionConfig,
  toCompressionTriggerConfig,
} from "../../src/lib/compression-config.js";

describe("compression-config bridge", () => {
  it("maps Config.compression to engine CompressionConfig", () => {
    const engineCfg = toCompressionConfig(DEFAULT_CONFIG);
    expect(engineCfg.cluster_similarity_threshold).toBe(
      DEFAULT_CONFIG.compression.clusterSimilarityThreshold,
    );
    expect(engineCfg.min_cluster_size).toBe(DEFAULT_CONFIG.compression.minClusterSize);
    expect(engineCfg.max_body_ratio).toBe(DEFAULT_CONFIG.compression.maxBodyRatio);
    expect(engineCfg.temporal_window_hours).toBe(DEFAULT_CONFIG.compression.temporalWindowHours);
  });

  it("maps Config.compression to CompressionTriggerConfig", () => {
    const triggerCfg = toCompressionTriggerConfig(DEFAULT_CONFIG);
    expect(triggerCfg.memory_count_threshold).toBe(
      DEFAULT_CONFIG.compression.memoryCountThreshold,
    );
    expect(triggerCfg.auto_capture_batch).toBe(
      DEFAULT_CONFIG.compression.autoCaptureBatchThreshold,
    );
    expect(triggerCfg.staleness_days).toBe(DEFAULT_CONFIG.compression.stalenessDays);
  });

  it("propagates user overrides", () => {
    const overridden = structuredClone(DEFAULT_CONFIG);
    overridden.compression.clusterSimilarityThreshold = 0.9;
    overridden.compression.minClusterSize = 5;
    overridden.compression.memoryCountThreshold = 999;

    const engineCfg = toCompressionConfig(overridden);
    expect(engineCfg.cluster_similarity_threshold).toBe(0.9);
    expect(engineCfg.min_cluster_size).toBe(5);

    const triggerCfg = toCompressionTriggerConfig(overridden);
    expect(triggerCfg.memory_count_threshold).toBe(999);
  });
});
