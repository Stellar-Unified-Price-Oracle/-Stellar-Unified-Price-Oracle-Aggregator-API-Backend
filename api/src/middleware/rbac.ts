import { Request, Response, NextFunction } from 'express';

export type Role = 'admin' | 'operator' | 'viewer';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userRole?: Role;
    }
  }
}

export const ROLES: Role[] = ['admin', 'operator', 'viewer'];

export const ROLE_PERMISSIONS: Record<Role, string[]> = {
  admin: ['keys:read', 'keys:write', 'keys:delete', 'keys:rotate', 'roles:write', 'metrics:read'],
  operator: ['keys:read', 'keys:write', 'metrics:read'],
  viewer: ['keys:read', 'metrics:read'],
};

const ROLE_LEVEL: Record<Role, number> = {
  admin: 3,
  operator: 2,
  viewer: 1,
};

export function requireRole(minRole: Role) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = req.userRole || 'viewer';
    if (ROLE_LEVEL[role] < ROLE_LEVEL[minRole]) {
      res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: `This operation requires '${minRole}' role or higher`,
        },
      });
      return;
    }
    next();
  };
}
