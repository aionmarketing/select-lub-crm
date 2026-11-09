/**
 * Port for listing mock Omie catalog products.
 */
import type { MockCatalogProduct } from "./dataset.js";

/** Lists mock catalog products. Never opens a network connection. */
export type OmieProductsPort = {
  /**
   * Returns every mock catalog product.
   *
   * @returns Cloned product rows.
   */
  listProducts(): Promise<MockCatalogProduct[]>;
};

/**
 * In-memory product port seeded from the mock dataset.
 *
 * @param rows - Dataset clone the source owns.
 * @returns Port whose `listProducts` returns a clone of `rows`.
 */
export function createMockProductsPort(rows: MockCatalogProduct[]): OmieProductsPort {
  return {
    async listProducts() {
      return structuredClone(rows);
    },
  };
}
