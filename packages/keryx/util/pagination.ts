/**
 * Standardized pagination response envelope.
 */
export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

/**
 * Applies pagination to a Drizzle select query and returns a standardized envelope.
 *
 * Runs the data query (with LIMIT/OFFSET) and a COUNT query in parallel for efficiency.
 * The caller provides both queries separately so they can use different joins or WHERE
 * clauses for the count (e.g., skipping expensive JOINs that don't affect the total).
 *
 * @param query - A Drizzle select query builder that has not yet had `.limit()` or
 *   `.offset()` applied. Must support chaining `.limit(n).offset(n)`.
 * @param countQuery - A promise resolving to `[{ count: number }]`. Typically built with
 *   `db.select({ count: count() }).from(table).where(...)`.
 * @param params - Object with `page` (1-indexed) and `limit`, matching the output of
 *   `paginationInputs()`.
 * @returns A `PaginatedResult<T>` containing the `data` array and `pagination` metadata.
 */
export async function paginate<T>(
  query: {
    limit: (n: number) => { offset: (n: number) => PromiseLike<T[]> };
  },
  countQuery: PromiseLike<{ count: number }[]>,
  params: { page: number; limit: number },
): Promise<PaginatedResult<T>> {
  const offset = (params.page - 1) * params.limit;

  const [data, countResult] = await Promise.all([
    query.limit(params.limit).offset(offset),
    countQuery,
  ]);

  const total = Number(countResult[0]?.count ?? 0);

  return {
    data,
    pagination: {
      page: params.page,
      limit: params.limit,
      total,
      pages: Math.ceil(total / params.limit),
    },
  };
}
