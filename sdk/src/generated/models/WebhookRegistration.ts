/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type WebhookRegistration = {
    url?: string;
    trigger?: {
        type?: WebhookRegistration.type;
        asset?: string;
        value?: number;
    };
};
export namespace WebhookRegistration {
    export enum type {
        THRESHOLD = 'threshold',
        INTERVAL = 'interval',
    }
}

