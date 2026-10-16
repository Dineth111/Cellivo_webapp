import fs from 'node:fs';
import path from 'node:path';
import './cellivo.css';
import SiteHeader from './SiteHeader';
import SiteEnhance from './SiteEnhance';

// Public website = cellivo.com's own markup + stylesheet (scoped to .cv). Regenerate with .cellivo-ref/build.mjs.
const read = (file) => fs.readFileSync(path.join(process.cwd(), 'src/site', file), 'utf8');

export default function SiteFrame({ slug }) {
  const html = read(`pages/${slug.replace('/', '__')}.html`) + read('footer.html');
  return (
    <div className="cv min-h-screen bg-background">
      <SiteHeader />
      <div style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: html }} />
      <SiteEnhance />
    </div>
  );
}
