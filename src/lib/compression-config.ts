import type { Config } from "./config.js";
import type {
  CompressionConfig,
  CompressionTriggerConfig,
} from "../engine/compressor.js";

/** Map the user-facing Config.compression section to the engine's CompressionConfig. */
export function toCompressionConfig(config: Config): CompressionConfig {
  return {
    cluster_similarity_threshold: config.compression.clusterSimilarityThreshold,
    min_cluster_size: config.compression.minClusterSize,
    max_body_ratio: config.compression.maxBodyRatio,
    temporal_window_hours: config.compression.temporalWindowHours,
    qualityFloor: config.compression.qualityFloor,
  };
}

export function toCompressionTriggerConfig(config: Config): CompressionTriggerConfig {
  return {
    memory_count_threshold: config.compression.memoryCountThreshold,
    auto_capture_batch: config.compression.autoCaptureBatchThreshold,
    staleness_days: config.compression.stalenessDays,
  };
}
