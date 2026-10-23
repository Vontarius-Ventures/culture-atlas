import Link from 'next/link';
import { Icon } from '../Icon';
import { ExperimentalBadge } from './parts';

/** Settings entry for Devices (PRODUCT-AND-ARCHITECTURE: "Devices lives there"). */
export function DevicesEntry() {
  return (
    <section className="settings__section" aria-labelledby="devices-heading">
      <h2 id="devices-heading" className="section-title section-title--display">
        Devices
      </h2>
      <p className="muted">
        Phones signed in to your account, and Meta glasses <ExperimentalBadge quiet />.
      </p>
      <p style={{ marginTop: 12 }}>
        <Link href="/settings/devices" className="button button--outline">
          Manage devices
          <Icon name="chevronRight" size={18} />
        </Link>
      </p>
    </section>
  );
}
