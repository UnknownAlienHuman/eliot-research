/** Portable table/column inventory shape consumed by the backup schema protocol. */
export interface TableSpec {
  readonly manifest: string;
  readonly table: string;
  readonly order_by: string;
  readonly columns: Readonly<Record<string, "text" | "int" | "real" | "text-or-null" | "int-or-null" | "real-or-null">>;
  readonly required: boolean;
}
