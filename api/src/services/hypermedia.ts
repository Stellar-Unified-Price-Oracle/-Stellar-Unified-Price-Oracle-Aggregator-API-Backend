// HAL-style hypermedia link builders so clients can navigate the API without
// hardcoding URL patterns.

export interface HalLink {
  href: string;
  method?: string;
  title?: string;
}

export type HalLinks = Record<string, HalLink>;

function base(): string {
  return '/api/v1';
}

export function withLinks<T extends object>(resource: T, links: HalLinks): T & { _links: HalLinks } {
  return { ...resource, _links: links };
}

export const links = {
  root(): HalLinks {
    return {
      self: { href: `${base()}/`, method: 'GET' },
      prices: { href: `${base()}/prices`, method: 'GET', title: 'List all asset prices' },
      sources: { href: `${base()}/sources`, method: 'GET', title: 'List price sources' },
      health: { href: `${base()}/health`, method: 'GET', title: 'Service health' },
      docs: { href: `${base()}/docs`, method: 'GET', title: 'API documentation' },
      usage: { href: `${base()}/usage/dashboard`, method: 'GET', title: 'API usage dashboard' },
      webhooks: { href: `${base()}/webhooks`, method: 'GET', title: 'Manage webhooks' },
    };
  },

  asset(asset: string): HalLinks {
    const symbol = asset.toUpperCase();
    return {
      self: { href: `${base()}/prices/${symbol}`, method: 'GET' },
      history: { href: `${base()}/history/${symbol}`, method: 'GET', title: 'Price history for this asset' },
      registerWebhook: {
        href: `${base()}/webhooks`,
        method: 'POST',
        title: 'Register a webhook for price updates on this asset',
      },
    };
  },

  prices(): HalLinks {
    return {
      self: { href: `${base()}/prices`, method: 'GET' },
      sources: { href: `${base()}/sources`, method: 'GET' },
    };
  },

  history(asset: string): HalLinks {
    const symbol = asset.toUpperCase();
    return {
      self: { href: `${base()}/history/${symbol}`, method: 'GET' },
      price: { href: `${base()}/prices/${symbol}`, method: 'GET', title: 'Current price for this asset' },
    };
  },

  webhook(id: string): HalLinks {
    return {
      self: { href: `${base()}/webhooks/${id}`, method: 'GET' },
      delete: { href: `${base()}/webhooks/${id}`, method: 'DELETE' },
      deliveries: { href: `${base()}/webhooks/${id}/deliveries`, method: 'GET', title: 'Delivery log' },
    };
  },
};
