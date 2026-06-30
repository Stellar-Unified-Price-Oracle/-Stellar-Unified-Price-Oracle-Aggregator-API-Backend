/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type HealthCheck = {
    service?: string;
    status?: HealthCheck.status;
    uptime?: number;
    timestamp?: number;
    assetsTracked?: number;
};
export namespace HealthCheck {
    export enum status {
        HEALTHY = 'healthy',
        DEGRADED = 'degraded',
        UNHEALTHY = 'unhealthy',
    }
}

