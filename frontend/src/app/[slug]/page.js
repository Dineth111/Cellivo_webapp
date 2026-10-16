import { notFound } from 'next/navigation';
import ContentPage from '../../components/site/ContentPage';
import { PAGES } from '../../components/site/siteContent';

// Feature, industry, affiliate and legal pages from cellivo.com. Unknown slugs 404.
export const dynamicParams = false;
export const generateStaticParams = () => Object.keys(PAGES).map((slug) => ({ slug }));

export async function generateMetadata({ params }) {
  const page = PAGES[(await params).slug];
  return page ? { title: page.title, description: page.description } : {};
}

export default async function Page({ params }) {
  const { slug } = await params;
  const page = PAGES[slug];
  if (!page) notFound();
  return <ContentPage slug={slug} page={page} active={`/${slug}`} />;
}
