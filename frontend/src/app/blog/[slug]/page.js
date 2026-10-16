import { notFound } from 'next/navigation';
import ContentPage from '../../../components/site/ContentPage';
import { POSTS } from '../../../components/site/siteContent';

export const dynamicParams = false;
export const generateStaticParams = () => Object.keys(POSTS).map((slug) => ({ slug }));

export async function generateMetadata({ params }) {
  const post = POSTS[(await params).slug];
  return post ? { title: post.title, description: post.description } : {};
}

export default async function BlogPost({ params }) {
  const { slug } = await params;
  const post = POSTS[slug];
  if (!post) notFound();
  return <ContentPage slug={slug} page={post} active="/blog" />;
}
