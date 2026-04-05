import { describe, expect, test } from "bun:test";
import { paginate } from "../../util/pagination";

describe("paginate", () => {
  test("calculates correct offset and pages", async () => {
    const mockData = [{ id: 3 }, { id: 4 }];
    let capturedLimit = 0;
    let capturedOffset = 0;
    const mockQuery = {
      limit: (n: number) => {
        capturedLimit = n;
        return {
          offset: (o: number) => {
            capturedOffset = o;
            return Promise.resolve(mockData);
          },
        };
      },
    };

    const result = await paginate(mockQuery, Promise.resolve([{ count: 10 }]), {
      page: 2,
      limit: 2,
    });

    expect(capturedLimit).toBe(2);
    expect(capturedOffset).toBe(2); // (page 2 - 1) * limit 2
    expect(result.data).toEqual(mockData);
    expect(result.pagination).toEqual({
      page: 2,
      limit: 2,
      total: 10,
      pages: 5,
    });
  });

  test("handles empty results", async () => {
    const mockQuery = {
      limit: () => ({ offset: () => Promise.resolve([]) }),
    };

    const result = await paginate(mockQuery, Promise.resolve([{ count: 0 }]), {
      page: 1,
      limit: 10,
    });

    expect(result.data).toEqual([]);
    expect(result.pagination).toEqual({
      page: 1,
      limit: 10,
      total: 0,
      pages: 0,
    });
  });

  test("rounds pages up", async () => {
    const mockQuery = {
      limit: () => ({
        offset: () => Promise.resolve([{ id: 1 }]),
      }),
    };

    const result = await paginate(mockQuery, Promise.resolve([{ count: 11 }]), {
      page: 1,
      limit: 5,
    });

    expect(result.pagination.pages).toBe(3); // ceil(11/5) = 3
  });

  test("page 1 uses offset 0", async () => {
    let capturedOffset = -1;
    const mockQuery = {
      limit: () => ({
        offset: (o: number) => {
          capturedOffset = o;
          return Promise.resolve([]);
        },
      }),
    };

    await paginate(mockQuery, Promise.resolve([{ count: 0 }]), {
      page: 1,
      limit: 25,
    });

    expect(capturedOffset).toBe(0);
  });
});
