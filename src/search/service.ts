import { Store } from '../sql/store.ts';
import { searchCodeFts, rebuildFts, FtsSearchResult } from './fts.ts';
import { semanticSearch, SemanticHit, SemanticSearchOptions } from './semantic.ts';
import {
  buildEmbeddings, buildEmbeddingsAsync, BuildEmbeddingsResult,
  ensureModelStrategy, AsyncEmbedFn,
} from './semantic.ts';

export interface BuildIndexResult extends BuildEmbeddingsResult {
  ftsBuilt: boolean;
  usedModel: boolean;
}

export function buildIndex(store: Store, project: string): BuildIndexResult {
  rebuildFts(store, project);
  const emb = buildEmbeddings(store, project);
  return { ...emb, ftsBuilt: true, usedModel: false };
}

export async function buildIndexAsync(
  store: Store,
  project: string,
  strategy: AsyncEmbedFn | null = null,
): Promise<BuildIndexResult> {
  rebuildFts(store, project);
  const model = strategy ?? (await ensureModelStrategy());
  const emb = await buildEmbeddingsAsync(store, project, model);
  return { ...emb, ftsBuilt: true, usedModel: model != null };
}

export function searchCode(store: Store, project: string, pattern: string, limit = 10): FtsSearchResult[] {
  return searchCodeFts(store, project, pattern, limit);
}

export function semanticQuery(
  store: Store,
  project: string,
  query: string,
  limit = 10,
  opts: SemanticSearchOptions = {},
): SemanticHit[] {
  return semanticSearch(store, project, query, limit, opts);
}

export async function detectEmbeddingModel(): Promise<string> {
  const model = await ensureModelStrategy();
  return model ? 'transformers' : 'hashing';
}
