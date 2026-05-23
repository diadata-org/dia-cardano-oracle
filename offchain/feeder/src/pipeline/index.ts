// Public surface of the data pipeline (enrich + transform). The
// scanner feeds into this, the router consumes from it.

export {
  createRegistryEnricher,
  enrichEvents,
  type Enricher,
} from "./enricher.js";

export {
  createTransformer,
  identityTransformer,
  type Transformer,
} from "./transformer.js";
