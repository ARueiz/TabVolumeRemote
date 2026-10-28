// One explicit policy is shared by classic extension scripts and the Node server.
(() => {
  let sites = [
    { origin: "https://www.youtube.com", name: "YouTube" },
    { origin: "https://www.twitch.tv", name: "Twitch" },
    { origin: "https://hamivideo.hinet.net", name: "Hami Video" }
  ];
  function siteForUrl(value) {
    try {
      let url = new URL(value);
      if (url.username || url.password) return null;
      return sites.find(site => site.origin === url.origin) || null;
    } catch { return null; }
  }
  let policy = {
    matches: sites.map(site => `${site.origin}/*`),
    siteForUrl,
    isSupportedUrl: value => Boolean(siteForUrl(value))
  };
  if (typeof module !== "undefined" && module.exports) module.exports = policy;
  else globalThis.TabVolumeSites = policy;
})();
