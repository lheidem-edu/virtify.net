/**
 * Importing this file is what puts the endpoints into the registry — a path
 * registers itself as a side effect of its module being loaded. The spec
 * builder imports it so the document can never be built from a half-filled
 * registry.
 */
import "./customers";
import "./health";
