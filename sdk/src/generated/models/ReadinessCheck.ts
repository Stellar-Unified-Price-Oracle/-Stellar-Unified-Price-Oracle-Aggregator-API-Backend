/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ReadinessCheck = {
    status?: ReadinessCheck.status;
    assetsTracked?: number;
};
export namespace ReadinessCheck {
    export enum status {
        READY = 'ready',
        NOT_READY = 'not_ready',
    }
}

