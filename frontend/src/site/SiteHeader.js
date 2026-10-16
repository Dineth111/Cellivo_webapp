'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Building2, ChevronDown, Hash, HeartHandshake, Landmark, LayoutGrid, Menu, Package, Plug, Receipt, ShieldCheck, TrendingUp, Users, Wallet, Wrench, X } from 'lucide-react';

// Port of the cellivo.com header (Layout chunk): same links, classes and mega menu.
const MEGA = [
  { name: 'Sales & POS', links: [
    { label: 'POS & Billing', path: '/billing-software-for-mobile-shop', icon: Receipt, desc: 'Fast billing & invoicing' },
    { label: 'Repair Management', path: '/mobile-repair-management-software', icon: Wrench, desc: 'Job tracking & invoicing' },
    { label: 'Credit & Loyalty', path: '/customer-loyalty-system', icon: HeartHandshake, desc: 'Installments & rewards' },
  ] },
  { name: 'Inventory & Stock', links: [
    { label: 'IMEI Tracking', path: '/imei-tracking-pos-system', icon: Hash, desc: 'IMEI-level stock control' },
    { label: 'Inventory Management', path: '/inventory-management-system', icon: Package, desc: 'Purchase orders & GRN' },
    { label: 'Multi-Branch', path: '/multi-branch-pos-system', icon: Building2, desc: 'Branch transfers & control' },
  ] },
  { name: 'Finance & Team', links: [
    { label: 'Cash Drawer', path: '/cash-drawer-management', icon: Wallet, desc: 'Sessions & ledger control' },
    { label: 'Banking & Credit', path: '/banking-credit-cheques', icon: Landmark, desc: 'Reconciliation & cheques' },
    { label: 'Staff & Payroll', path: '/staff-commissions-payroll', icon: Users, desc: 'Commissions & payslips' },
  ] },
  { name: 'Reports & Platform', links: [
    { label: 'Reports & Analytics', path: '/features#reports', icon: TrendingUp, desc: 'Sales, profit & KPI reports' },
    { label: 'Integrations', path: '/integrations', icon: Plug, desc: 'WooCommerce, SMS & more' },
    { label: 'Security & Settings', path: '/settings-security-integrations', icon: ShieldCheck, desc: 'Roles, audit & access' },
  ] },
];
const MEGA_PATHS = MEGA.flatMap((g) => g.links.map((l) => l.path));
const NAV = [
  { label: 'Home', path: '/' },
  { label: 'Features', path: '/features', mega: true },
  { label: 'Mobile Shop POS', path: '/mobile-shop-pos-system' },
  { label: 'POS for Phone Shops', path: '/pos-system-for-phone-shop' },
  { label: 'Pricing', path: '/pricing' },
  { label: 'Blog', path: '/blog' },
  { label: 'About', path: '/about' },
  { label: 'Contact', path: '/contact' },
];
const BTN = 'inline-flex items-center justify-center gap-2 whitespace-nowrap ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0';
const PILL = 'px-3.5 py-1.5 text-[13px] font-medium rounded-full transition-all duration-200';
const ON = 'bg-background text-foreground shadow-sm';
const OFF = 'text-muted-foreground hover:text-foreground';

export default function SiteHeader() {
  const path = usePathname();
  const [scrolled, setScrolled] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [mega, setMega] = useState(false);
  const [mobileFeatures, setMobileFeatures] = useState(false);
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  const featuresActive = MEGA_PATHS.includes(path) || path === '/features';

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 10);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => { setMobile(false); setMega(false); setMobileFeatures(false); }, [path]);
  useEffect(() => {
    const close = (e) => {
      if (!btnRef.current?.contains(e.target) && !panelRef.current?.contains(e.target)) setMega(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const headerCls = mobile
    ? 'z-[60] bg-white transition-none'
    : scrolled
      ? 'z-50 transition-all duration-300 bg-background/80 backdrop-blur-xl border-b border-border/50 shadow-sm'
      : 'z-50 transition-all duration-300 bg-background/60 backdrop-blur-md';

  return (
    <header className={`fixed top-0 left-0 right-0 ${headerCls}`}>
      <nav className="container mx-auto flex items-center justify-between h-16 px-4 lg:px-8">
        <Link href="/" className="flex items-center gap-2.5 shrink-0">
          <img src="/cellivo/assets/cellivo-logo-itWC9rrA.webp" alt="Cellivo" width="115" height="24" className="h-7 w-auto" />
        </Link>
        <div className="hidden lg:flex items-center gap-1 bg-secondary/50 rounded-full px-1.5 py-1">
          {NAV.map((t) => (t.mega ? (
            <div key={t.path} ref={btnRef} className="relative">
              <button onClick={() => setMega(!mega)} aria-expanded={mega} className={`flex items-center gap-1 ${PILL} ${featuresActive ? ON : OFF}`}>
                {t.label}<ChevronDown size={12} className={`transition-transform duration-200 ${mega ? 'rotate-180' : ''}`} />
              </button>
              {mega && (
                <div ref={panelRef} className="fixed left-1/2 -translate-x-1/2 mt-3 w-[960px] mega-menu-glass rounded-2xl overflow-hidden z-50 animate-in fade-in-0" style={{ top: 52 }}>
                  <div className="px-6 pt-5 pb-3 border-b border-border/50">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-heading font-semibold text-foreground">Features</h3>
                      <Link href="/features" className="text-xs font-medium text-primary hover:text-primary/80 transition-colors">View all features →</Link>
                    </div>
                  </div>
                  <div className="p-4 grid grid-cols-4 gap-x-6 gap-y-4">
                    {MEGA.map((g) => (
                      <div key={g.name}>
                        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-2 px-2">{g.name}</p>
                        <div className="space-y-0.5">
                          {g.links.map(({ label, path: href, icon: Icon, desc }) => {
                            const on = path === href;
                            return (
                              <Link key={href} href={href} className={`group flex items-start gap-3 px-2 py-2 rounded-xl transition-all duration-150 ${on ? 'bg-primary/10' : 'hover:bg-secondary/50'}`}>
                                <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors duration-150 ${on ? 'bg-primary/20 text-primary' : 'bg-secondary/80 text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary'}`}><Icon size={15} /></div>
                                <div className="min-w-0">
                                  <p className={`text-[13px] font-medium leading-tight transition-colors ${on ? 'text-primary' : 'text-foreground/90 group-hover:text-foreground'}`}>{label}</p>
                                  <p className="text-[11px] text-muted-foreground/60 leading-tight mt-0.5 truncate">{desc}</p>
                                </div>
                              </Link>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="px-6 py-3.5 border-t border-border/50 bg-secondary/30 flex items-center justify-between">
                    <p className="text-xs text-muted-foreground/60">Manage your entire phone shop from one platform.</p>
                    <Link href="/pricing"><button className={`${BTN} bg-primary text-primary-foreground hover:bg-primary/90 rounded-full text-xs h-7 px-4 font-medium`}>Start Free Trial →</button></Link>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <Link key={t.path} href={t.path} className={`${PILL} ${path === t.path ? ON : OFF}`}>{t.label}</Link>
          )))}
        </div>
        <div className="hidden w-[218px] shrink-0 items-center justify-end gap-2 lg:flex">
          <Link href="/login" className="text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors px-3 py-1.5">Log in</Link>
          <Link href="/pricing"><button className={`${BTN} py-3 bg-primary text-primary-foreground hover:bg-primary/90 font-medium px-5 h-9 text-[13px] rounded-full shadow-sm`}>Start Free Trial →</button></Link>
        </div>
        <button className="lg:hidden relative z-[60] flex h-10 w-10 items-center justify-center text-foreground rounded-lg hover:bg-secondary/50 transition-colors" onClick={() => setMobile(!mobile)} aria-expanded={mobile} aria-label="Toggle menu">
          {mobile ? <X size={20} /> : <Menu size={20} />}
        </button>
      </nav>

      {mobile && (
        <div className="fixed inset-0 z-50 bg-white lg:hidden">
          <div className="h-16" />
          <div className="flex h-[calc(100vh-4rem)] flex-col overflow-y-auto px-6 py-6">
            <div className="flex flex-col gap-1">
              {NAV.map((t) => (
                <div key={t.path}>
                  {t.mega ? (
                    <div>
                      <button onClick={() => setMobileFeatures(!mobileFeatures)} aria-expanded={mobileFeatures} className={`w-full flex items-center justify-between px-4 py-3.5 rounded-2xl text-base font-semibold transition-all duration-200 ${featuresActive ? 'text-foreground bg-secondary/70' : 'text-foreground/80 hover:text-foreground hover:bg-secondary/40'}`}>
                        {t.label}<ChevronDown size={16} className={`transition-transform duration-200 ${mobileFeatures ? 'rotate-180' : ''}`} />
                      </button>
                      {mobileFeatures && (
                        <div className="overflow-hidden"><div className="pl-2 pt-1 pb-2">
                          <Link href="/features" className="flex items-center gap-3 px-4 py-2.5 text-sm font-semibold text-primary hover:bg-primary/5 rounded-xl transition-colors"><LayoutGrid size={16} />All Features →</Link>
                          {MEGA.map((g) => (
                            <div key={g.name} className="mt-3">
                              <p className="px-4 text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground/50 mb-1.5">{g.name}</p>
                              {g.links.map(({ label, path: href, icon: Icon, desc }) => (
                                <Link key={href} href={href} className={`flex items-center gap-3 px-4 py-2.5 text-sm rounded-xl transition-all duration-150 ${path === href ? 'text-primary bg-primary/5 font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/40'}`}>
                                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${path === href ? 'bg-primary/15 text-primary' : 'bg-secondary/80 text-muted-foreground'}`}><Icon size={13} /></div>
                                  <div><p className="leading-tight">{label}</p><p className="text-[11px] text-muted-foreground/50 leading-tight">{desc}</p></div>
                                </Link>
                              ))}
                            </div>
                          ))}
                        </div></div>
                      )}
                    </div>
                  ) : (
                    <Link href={t.path} className={`block px-4 py-3.5 rounded-2xl text-base font-semibold transition-all duration-200 ${path === t.path ? 'text-foreground bg-secondary/70' : 'text-foreground/80 hover:text-foreground hover:bg-secondary/40'}`}>{t.label}</Link>
                  )}
                </div>
              ))}
            </div>
            <div className="flex-1 min-h-6" />
            <div className="flex flex-col gap-3 border-t border-border/50 pt-6">
              <Link href="/login" className={`${BTN} border border-input bg-background hover:bg-accent hover:text-accent-foreground w-full font-semibold h-12 rounded-2xl text-sm border-border/60`}>Log in</Link>
              <Link href="/pricing"><button className={`${BTN} w-full bg-primary text-primary-foreground font-semibold h-12 rounded-2xl text-sm shadow-sm`}>Start Free Trial →</button></Link>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
