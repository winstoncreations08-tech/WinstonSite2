import clsx from 'clsx';
import loaderStore from '/src/utils/hooks/loader/useLoaderStore';
import StaticError from './viewer/StaticError';
import { useOptions } from '/src/utils/optionsContext';
import { useRef, useEffect, useCallback } from 'react';
import { Loader } from 'lucide-react';
import { process as processUrl, processWithEngine } from '/src/utils/hooks/loader/utils';
import {
  startTracking,
  stopTracking,
  recordSuccess,
  recordFailure,
  detectEngine,
  extractHostname,
  MAX_ENGINE_RETRIES,
} from '/src/utils/hooks/loader/adaptiveEngine';

import NewTab from './NewTab';

const Viewer = ({ conf = {} }) => {
  const tabs = loaderStore((state) => state.tabs);
  const updateUrl = loaderStore((state) => state.updateUrl);
  const updateTitle = loaderStore((state) => state.updateTitle);
  const setLoading = loaderStore((state) => state.setLoading);
  const setRetryCount = loaderStore((state) => state.setRetryCount);
  const setFrameRefs = loaderStore((state) => state.setFrameRefs);
  // wispStatus: reps. if working Wisp server is found
  // (only when isStaticBuild == true)
  const wispStatus = loaderStore((state) => state.wispStatus);
  const { iframeUrls, setIframeUrl, showMenu, toggleMenu } = loaderStore();
  const frameRefs = useRef({});
  const prevURL = useRef({});
  const prevTitle = useRef({});
  const { options } = useOptions();
  const updateActiveFrameRef = loaderStore((state) => state.updateActiveFrameRef);
  const activeFrameRef = loaderStore((state) => state.activeFrameRef);
  const enableAlerts = conf.alerts ?? true;

  // ─── Adaptive retry handler ──────────────────────────────────────
  const handleAdaptiveRetry = useCallback((tabId, hostname, failedEngine) => {
    const tab = loaderStore.getState().tabs.find(t => t.id === tabId);
    if (!tab || (tab.retryCount || 0) >= MAX_ENGINE_RETRIES) {
      // Already retried max times — stop to avoid loops
      console.log(`[AdaptiveEngine] Max retries reached for ${hostname}, keeping current engine`);
      return;
    }

    const { shouldRetry, alternateEngine } = recordFailure(tabId);
    if (!shouldRetry || !alternateEngine) return;

    // Decode the original URL from the current proxied URL
    const rawUrl = processUrl(tab.url, true, options.prType || 'auto', options.engine || undefined);
    if (!rawUrl || rawUrl === tab.url) return;

    // Re-encode with the alternate engine
    const newUrl = processWithEngine(rawUrl, alternateEngine);
    if (!newUrl) return;

    console.log(`[AdaptiveEngine] Retrying ${hostname} with ${alternateEngine}`);
    setRetryCount(tabId, (tab.retryCount || 0) + 1);
    updateUrl(tabId, newUrl, false); // false = don't add to history (this is a retry)
  }, [options.prType, options.engine, setRetryCount, updateUrl]);

  // ─── Start adaptive tracking when a tab navigates to a proxied URL ──
  useEffect(() => {
    tabs.forEach((tab) => {
      if (tab.url === 'tabs://new') return;
      const engine = detectEngine(tab.url);
      if (!engine) return;

      const rawUrl = processUrl(tab.url, true, options.prType || 'auto', options.engine || undefined);
      const hostname = extractHostname(rawUrl);
      if (!hostname) return;

      if (tab.isLoading) {
        startTracking(tab.id, hostname, engine, (tId, host, eng) => {
          handleAdaptiveRetry(tId, host, eng);
        });
      }
    });
  }, [tabs.map(t => t.url + t.isLoading).join(',')]); // re-run when urls or loading state change

  // Clean up tracking on tab removal
  useEffect(() => {
    return () => {
      tabs.forEach((tab) => stopTracking(tab.id));
    };
  }, []);

  useEffect(() => {
    setFrameRefs(frameRefs);
    const tabIds = new Set(tabs.map((t) => t.id));
    Object.keys(frameRefs.current).forEach((id) => {
      if (!tabIds.has(id)) {
        stopTracking(id); // clean up timer for removed tabs
        delete frameRefs.current[id];
      }
    });
  }, [setFrameRefs, tabs]);

  useEffect(() => {
    const listeners = [];
    tabs.forEach((tab) => {
      if (tab.url === 'tabs://new') return;
      const iframe = frameRefs.current[tab.id];
      if (!iframe) return;
      const handleLoad = () => {
        setLoading(tab.id, false);

        // Record successful load for adaptive engine
        recordSuccess(tab.id);
        // Reset retry count on successful load
        if (tab.retryCount > 0) setRetryCount(tab.id, 0);

        try {
          const d = iframe.contentWindow?.document;
          if (d?.getElementById('errorTrace-wrapper') || d?.getElementById('uvHostname')) {
            // Proxy error detected — try alternate engine instead of just reloading
            const engine = detectEngine(tab.url);
            const rawUrl = processUrl(tab.url, true, options.prType || 'auto', options.engine || undefined);
            const hostname = extractHostname(rawUrl);
            if (engine && hostname && (tab.retryCount || 0) < MAX_ENGINE_RETRIES) {
              handleAdaptiveRetry(tab.id, hostname, engine);
            } else {
              // Fallback: reload same URL (original behavior)
              iframe.contentWindow.location.replace(tab.url);
            }
          }
          if (!enableAlerts && iframe.contentWindow) {
            iframe.contentWindow.alert = () => {};
          }
        } catch {}
      };
      const checkState = () => {
        try {
          const curURL = iframe.contentWindow.location.href;
          const curTTL = iframe.contentWindow.document.title;
          if (curURL === 'about:blank') return;
          // url shouldnt be updating if tab is still loading...will cause race condition
          if (!tab.isLoading && curURL !== prevURL.current[tab.id] && curURL !== tab.url) {
            prevURL.current[tab.id] = curURL;
            updateUrl(tab.id, curURL);
          }
          if (curTTL && curTTL !== prevTitle.current[tab.id] && curTTL !== tab.title) {
            prevTitle.current[tab.id] = curTTL;
            updateTitle(tab.id, curTTL);
          }
        } catch (e) {}
      };
      iframe.addEventListener('load', handleLoad);
      iframe.addEventListener('load', checkState);
      listeners.push({ iframe, handleLoad, checkState, tabId: tab.id });
      
      //try to remove it again
      if (!enableAlerts) {
        try {
          if (iframe.contentWindow) {
            iframe.contentWindow.alert = () => {};
          }
        } catch {}
      }
    });
    const interval = setInterval(() => {
      tabs.forEach((tab) => {
        if (tab.url === 'tabs://new') return;
        const iframe = frameRefs.current[tab.id];
        if (!iframe) return;
        try {
          const curURL = iframe.contentWindow.location.href;
          const curTTL = iframe.contentWindow.document.title;
          if (curURL === 'about:blank') return;
          const d = iframe.contentWindow?.document;
          if (d?.getElementById('errorTrace-wrapper') || d?.getElementById('uvHostname')) {
            // Proxy error: try adaptive retry instead of plain reload
            const engine = detectEngine(tab.url);
            const rawUrl = processUrl(tab.url, true, options.prType || 'auto', options.engine || undefined);
            const hostname = extractHostname(rawUrl);
            if (engine && hostname && (tab.retryCount || 0) < MAX_ENGINE_RETRIES) {
              handleAdaptiveRetry(tab.id, hostname, engine);
            } else {
              iframe.contentWindow.location.replace(tab.url);
            }
            return;
          }
          if (!enableAlerts && iframe.contentWindow) {
            iframe.contentWindow.alert = () => {};
          }
          // tab cant be loading while URL is being updated
          if (!tab.isLoading && curURL !== prevURL.current[tab.id] && curURL !== tab.url) {
            prevURL.current[tab.id] = curURL;
            setIframeUrl(tab.id, curURL);
          }
          if (curTTL && curTTL !== prevTitle.current[tab.id] && curTTL !== tab.title) {
            prevTitle.current[tab.id] = curTTL;
            updateTitle(tab.id, curTTL);
          }
        } catch (e) {}
      });
    }, 50);
    return () => {
      listeners.forEach(({ iframe, handleLoad, checkState }) => {
        iframe.removeEventListener('load', handleLoad);
        iframe.removeEventListener('load', checkState);
      });
      clearInterval(interval);
    };
  }, [tabs, setLoading, updateTitle, setIframeUrl, enableAlerts, handleAdaptiveRetry]);

  useEffect(() => {
    const interval = setInterval(() => {
      tabs.forEach((tab) => {
        if (tab.url === 'tabs://new') return;
        const iframe = frameRefs.current[tab.id];
        if (!iframe) return;
        try {
          const currentUrl = iframe.contentWindow.location.href;
          if (currentUrl !== iframeUrls[tab.id]) {
            setIframeUrl(tab.id, currentUrl);
          }
        } catch (e) {}
      });
    }, 500);

    return () => clearInterval(interval);
  }, [tabs, iframeUrls, setIframeUrl]);

  useEffect(() => {
    if (activeFrameRef?.current) {
      try {
        activeFrameRef.current.contentWindow.document.body.style.zoom = conf.zoom;
      } catch (e) {}
    }
  }, [activeFrameRef, conf.zoom]);

  useEffect(() => {
    tabs.forEach((tab) => {
      if (tab.active) {
        const iframeRef = { current: frameRefs.current[tab.id] };
        updateActiveFrameRef(iframeRef);
      }
    });
  }, [tabs]);

  const activeNewTab = tabs.find((tab) => tab.url === 'tabs://new' && tab.active);

  return (
    <div className="relative w-full h-full">
      {tabs.map(({ id, url, active }) => {
        if (url === 'tabs://new') return null;
        return (
          <div
            key={id}
            className={clsx(
              'absolute inset-0 w-full h-full',
              active ? 'opacity-100 z-10 pointer-events-auto' : 'opacity-0 z-0 pointer-events-none',
            )}
          >
            {active && (
              <div
                className="absolute inset-0 w-full h-full flex items-center justify-center -z-20"
                style={{ backgroundColor: options.tabBarColor || '#070e15' }}
              >
                {/*
                  If not static build, show loader
                  If static, show loader when wispStatus == true
                  If Wisp is still being found (init), show loading
                  Otherwise show error
                */}
                {!isStaticBuild ? (
                  <Loader size={32} className="animate-spin" />
                ) : wispStatus ? (
                  <div className="flex flex-col items-center gap-2">
                    <Loader size={32} className="animate-spin" />
                    {wispStatus === 'init' && (
                      <p className="mt-2">Finding a Wisp server to route your request...</p>
                    )}
                  </div>
                ) : wispStatus === false && (
                  <StaticError />
                )}
              </div>
            )}
            {/* if not static, show frame. otherwise if wisp is found (and is static) show iframe,
            otherwise display error msg */}
            {!isStaticBuild ? (
              <iframe
                ref={(el) => (frameRefs.current[id] = el)}
                src={url}
                style={{ display: 'block', width: '100%', height: '100%' }}
                className="absolute inset-0 w-full h-full transition-opacity duration-200"
              />
            ) : (
              wispStatus === true && (
                <iframe
                  ref={(el) => (frameRefs.current[id] = el)}
                  src={url}
                  style={{ display: 'block', width: '100%', height: '100%' }}
                  className="absolute inset-0 w-full h-full transition-opacity duration-200"
                />
              )
            )}

            {/*transparent overlay for when click on content */}
            {showMenu && (
              <div className="absolute inset-0 w-full h-full z-50" onClick={() => toggleMenu()} />
            )}
          </div>
        );
      })}
      {activeNewTab && (
        <div
          key={activeNewTab.id}
          className={clsx('absolute inset-0 w-full h-full', 'opacity-100 z-10 pointer-events-auto')}
        >
          <NewTab id={activeNewTab.id} updateFn={updateUrl} options={options} />
        </div>
      )}
    </div>
  );
};

export default Viewer;

