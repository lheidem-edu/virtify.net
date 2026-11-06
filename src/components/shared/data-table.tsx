"use client";

import {
    type ColumnDef,
    type ColumnFiltersState,
    flexRender,
    getCoreRowModel,
    getFacetedRowModel,
    getFacetedUniqueValues,
    getFilteredRowModel,
    getPaginationRowModel,
    getSortedRowModel,
    type SortingState,
    useReactTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown, Search } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";

const selectClass =
    "rounded-lg border bg-transparent px-3 py-2 text-sm text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none dark:bg-input/30";

export type FacetFilter = {
    columnId: string;
    label: string;
    options: { value: string; label: string }[];
};

/**
 * Shared table for every overview: sortable columns, a free-text search over
 * all of them, and optional dropdown filters for enumerated columns.
 * Sorting and filtering run client-side — these lists are per-account and
 * small, so paging them through the server would cost a round trip to save
 * nothing.
 */
export default function DataTable<TData>({
    columns,
    data,
    searchPlaceholder = "Suchen …",
    filters = [],
    emptyMessage = "Keine Einträge.",
    pageSize = 25,
}: {
    columns: ColumnDef<TData, unknown>[];
    data: TData[];
    searchPlaceholder?: string;
    filters?: FacetFilter[];
    emptyMessage?: string;
    pageSize?: number;
}) {
    const [sorting, setSorting] = useState<SortingState>([]);
    const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
    const [globalFilter, setGlobalFilter] = useState("");

    const table = useReactTable({
        data,
        columns,
        state: { sorting, columnFilters, globalFilter },
        onSortingChange: setSorting,
        onColumnFiltersChange: setColumnFilters,
        onGlobalFilterChange: setGlobalFilter,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        getPaginationRowModel: getPaginationRowModel(),
        getFacetedRowModel: getFacetedRowModel(),
        getFacetedUniqueValues: getFacetedUniqueValues(),
        initialState: { pagination: { pageSize } },
    });

    const rows = table.getRowModel().rows;
    const showPagination = table.getPageCount() > 1;

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <div className="relative min-w-56 flex-1">
                    <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={globalFilter}
                        onChange={(event) =>
                            setGlobalFilter(event.target.value)
                        }
                        placeholder={searchPlaceholder}
                        aria-label={searchPlaceholder}
                        className="pl-9"
                    />
                </div>

                {filters.map((filter) => {
                    const column = table.getColumn(filter.columnId);
                    const value = (column?.getFilterValue() as string) ?? "";

                    return (
                        <select
                            key={filter.columnId}
                            value={value}
                            aria-label={filter.label}
                            className={selectClass}
                            onChange={(event) =>
                                column?.setFilterValue(
                                    event.target.value || undefined,
                                )
                            }
                        >
                            <option value="">{filter.label}: alle</option>
                            {filter.options.map((option) => (
                                <option key={option.value} value={option.value}>
                                    {option.label}
                                </option>
                            ))}
                        </select>
                    );
                })}

                {globalFilter || columnFilters.length > 0 ? (
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                            setGlobalFilter("");
                            setColumnFilters([]);
                        }}
                    >
                        Zurücksetzen
                    </Button>
                ) : null}
            </div>

            <div className="overflow-x-auto rounded-lg border">
                <Table>
                    <TableHeader>
                        {table.getHeaderGroups().map((group) => (
                            <TableRow key={group.id}>
                                {group.headers.map((header) => {
                                    const canSort = header.column.getCanSort();
                                    const sorted = header.column.getIsSorted();

                                    return (
                                        <TableHead key={header.id}>
                                            {header.isPlaceholder ? null : canSort ? (
                                                <button
                                                    type="button"
                                                    onClick={header.column.getToggleSortingHandler()}
                                                    className="-mx-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:text-foreground"
                                                    aria-label={`Nach ${String(header.column.columnDef.header)} sortieren`}
                                                >
                                                    {flexRender(
                                                        header.column.columnDef
                                                            .header,
                                                        header.getContext(),
                                                    )}
                                                    {sorted === "asc" ? (
                                                        <ArrowUp className="size-3" />
                                                    ) : sorted === "desc" ? (
                                                        <ArrowDown className="size-3" />
                                                    ) : (
                                                        <ChevronsUpDown className="size-3 opacity-40" />
                                                    )}
                                                </button>
                                            ) : (
                                                flexRender(
                                                    header.column.columnDef
                                                        .header,
                                                    header.getContext(),
                                                )
                                            )}
                                        </TableHead>
                                    );
                                })}
                            </TableRow>
                        ))}
                    </TableHeader>

                    <TableBody>
                        {rows.length === 0 ? (
                            <TableRow>
                                <TableCell
                                    colSpan={columns.length}
                                    className="py-10 text-center text-muted-foreground"
                                >
                                    {emptyMessage}
                                </TableCell>
                            </TableRow>
                        ) : (
                            rows.map((row) => (
                                <TableRow key={row.id}>
                                    {row.getVisibleCells().map((cell) => (
                                        <TableCell key={cell.id}>
                                            {flexRender(
                                                cell.column.columnDef.cell,
                                                cell.getContext(),
                                            )}
                                        </TableCell>
                                    ))}
                                </TableRow>
                            ))
                        )}
                    </TableBody>
                </Table>
            </div>

            {showPagination ? (
                <div className="flex items-center justify-between gap-4">
                    <p className="text-xs text-muted-foreground">
                        Seite {table.getState().pagination.pageIndex + 1} von{" "}
                        {table.getPageCount()} · {rows.length} von {data.length}{" "}
                        Einträgen
                    </p>
                    <div className="flex gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={!table.getCanPreviousPage()}
                            onClick={() => table.previousPage()}
                        >
                            Zurück
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={!table.getCanNextPage()}
                            onClick={() => table.nextPage()}
                        >
                            Weiter
                        </Button>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
