/**
 * Production preflight (pnpm ops:preflight). Run by the Compose `preflight`
 * service before migrations; a failure keeps web and the workers from starting.
 * Prints setting NAMES only, never values.
 */
import { checkProductionEnv } from './production-env-lib';

const { errors, warnings } = checkProductionEnv(process.env);
for (const warning of warnings) console.warn(`[preflight] warning: ${warning}`);
if (errors.length > 0) {
  for (const error of errors) console.error(`[preflight] error: ${error}`);
  console.error(
    `[preflight] ${errors.length} production setting(s) must be fixed in .env before culture atlas starts (docs/production-readiness.md).`,
  );
  process.exit(1);
}
console.log(`[preflight] ok (${warnings.length} warning(s))`);
