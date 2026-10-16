import HomeGate from './HomeGate';
import SiteFrame from '../site/SiteFrame';
import META from '../site/meta.json';

export const metadata = { title: META.home.title, description: META.home.description };

export default function Page() {
  return <HomeGate site={<SiteFrame slug="home" />} />;
}
