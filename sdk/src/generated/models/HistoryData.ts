/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CursorPaginationMeta } from './CursorPaginationMeta';
import type { HistoryEntry } from './HistoryEntry';
export type HistoryData = {
    asset?: string;
    to?: number | null;
    prices?: Array<HistoryEntry>;
    pagination?: CursorPaginationMeta;
};

