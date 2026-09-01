import { Store } from '../sql/store.ts';
import { searchCodeFts, rebuildFts, FtsSearchResult } from './fts.ts';
import { buildEmbeddings, semanticSearch, SemanticHit, BuildEmbeddingsResult } from './semantic.ts';

export interface BuildIndexResult extends BuildEmbeddingsResult {
  ftsBuilt: boolean;
}

export function buildIndex(store: Store, project: string): BuildIndexResult {
  rebuildFts(store, project);
  const emb = buildEmbeddings(store, project);
  return { ...emb, ftsBuilt: true };
}

export function searchCode(store: Store, project: string, pattern: string, limit = 10): FtsSearchResult[] {
  return searchCodeFts(store, project, pattern, limit);
}

export function semanticQuery(store: Store, project: string, query: string, limit = 10): SemanticHit[] {
  return semanticSearch(store, project, query, limit);
}
