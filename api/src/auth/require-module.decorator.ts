import { SetMetadata } from '@nestjs/common';

export const REQUIRE_MODULE_KEY = 'requireModule';

/**
 * Gate a controller/route behind a platform module key (e.g. 'finops', 'security'). Non-admin users
 * without that module in their group access get 403. admin and full-access users always pass.
 */
export const RequireModule = (moduleKey: string) => SetMetadata(REQUIRE_MODULE_KEY, moduleKey);
