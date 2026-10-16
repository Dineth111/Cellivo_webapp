import { notFound } from 'next/navigation';
import SiteFrame from '../../site/SiteFrame';
import META from '../../site/meta.json';

// Every cellivo.com page except home (home is rendered by app/page.js for guests).
export const dynamicParams = false;
export const generateStaticParams = () => Object.keys(META).filter((s) => s !== 'home').map((s) => ({ path: s.split('/') }));

export async function generateMetadata({ params }) {
  const m = META[(await params).path.join('/')];
  return m ? { title: m.title, description: m.description } : {};
}

export default async function SitePage({ params }) {
  const slug = (await params).path.join('/');
  if (!META[slug] || slug === 'home') notFound();
  return <SiteFrame slug={slug} />;
}
