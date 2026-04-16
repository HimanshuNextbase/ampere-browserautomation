"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useAtomValue } from "jotai";
import { userAtom } from "@/src/atoms/userAuthAtom";
import { api } from "@/src/lib/api";
import { Monitor, Lock, Download, Loader2, Check, Shield, Globe, Cpu, ArrowRight, AlertTriangle, Mail, MessageCircle, X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from 'sonner';
import { trackEvent } from "@/src/lib/analytics";
import SubscriptionDialog from "@/src/components/dashboard/SubscriptionDialog";
import DownloadDialog from "./DownloadDialog";
import { Switch } from "@/src/components/ui/switch";
import { Card } from "@/src/components/ui/card";
// ===================== SECTION: Module Setup =====================

type InstallState = "idle" | "installing" | "installed" | "error";

// ===================== SECTION: DesktopAutomationSection =====================
export default function DesktopAutomationSection() {
  const user = useAtomValue(userAtom);
  const isFree = !user?.isPremium;

  const [enabled, setEnabled] = useState(false);
  const [installState, setInstallState] = useState<InstallState>("idle");
  const [showDialog, setShowDialog] = useState(false);
  const [showSubscription, setShowSubscription] = useState(false);
  const [showDownload, setShowDownload] = useState(false);
  const [showContactDialog, setShowContactDialog] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Check feature status on mount
  useEffect(() => {
    const checkFeatureStatus = async () => {
      try {
        const features = await api.getFeatures();
        if (features.stealthProxy === "installed") {
          setEnabled(true);
          setInstallState("installed");
        } else if (features.stealthProxy === "installing") {
          setInstallState("installing");
          startPolling();
        } else if (features.stealthProxy === "failed" || features.stealthProxy === "error") {
          setInstallState("error");
        }
      } catch {
        // silently fail on mount check
      }
    };
    checkFeatureStatus();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const features = await api.getFeatures();
        if (features.stealthProxy === "installed") {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setInstallState("installed");
          setTimeout(() => setShowDialog(true), 800);
        } else if (features.stealthProxy === "failed" || features.stealthProxy === "error") {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setInstallState("error");
          setShowContactDialog(true);
        }
      } catch {
        // keep polling on transient errors
      }
    }, 3000);
  }, []);

  const handleToggle = async () => {

    if (isFree) {
      setShowSubscription(true);
      return;
    }

    if (enabled) {
      setEnabled(false);
      trackEvent("desktop_automation_disabled");
      toast.success("Desktop automation disabled");
      return;
    }

    // Enable flow: check feature status, install if needed
    trackEvent("settings_browser_automation_click");
    trackEvent("desktop_automation_enable_clicked");

    try {
      const features = await api.getFeatures();

      if (features.stealthProxy === "installed") {
        // Already installed, just show dialog
        setInstallState("installed");
        setTimeout(() => setShowDialog(true), 300);
        return;
      }

      // Not installed — trigger install via feature endpoint
      setInstallState("installing");
      await api.installFeature("stealth-proxy");
      startPolling();
    } catch (err) {
      console.error("Failed to install browser automation feature:", err);
      setInstallState("error");
      setShowContactDialog(true);
    }
  };

  const handleDialogConfirm = () => {
    setEnabled(true);
    setShowDialog(false);
    setInstallState("idle");
    trackEvent("desktop_automation_enabled");
    toast.success("Desktop automation enabled!");
  };

  const handleDialogClose = () => {
    setShowDialog(false);
    setInstallState("idle");
  };

  return (
    <>
      <section>
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-lg font-semibold text-white">Browser Automation</h2>
          <span className="uppercase text-[10px] tracking-wider font-semibold bg-violet-500/20 text-violet-300 border border-violet-500/30 px-2 py-0.5 rounded-full">
            Alpha
          </span>
        </div>

        <Card className="shadow-[0_6px_0_0_rgba(255,255,255,0.04),inset_0_1px_0_0_rgba(255,255,255,0.1)] p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-lg bg-violet-500/10 border border-violet-500/20 flex items-center justify-center shrink-0">
                <Monitor size={18} className="text-violet-400" />
              </div>
              <div>
                <p className="text-sm text-white/80 font-medium">Browser Automation via Desktop App</p>
                <p className="text-xs text-white/40 mt-1 max-w-md">
                  Let your AI agent browse the web using your desktop's network. Routes traffic through your computer to bypass bot detection.
                </p>
              </div>
            </div>

            {/* Toggle / Install button */}
            <div className="shrink-0">
              {isFree ? (
                <button
                  onClick={handleToggle}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-white/[0.04] border border-white/[0.08] text-white/50 hover:bg-white/[0.06] transition-colors cursor-pointer"
                >
                  <Lock size={14} />
                  Upgrade
                </button>
              ) : installState === "installing" ? (
                <div className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-violet-500/10 border border-violet-500/20 text-violet-300">
                  <Loader2 size={14} className="animate-spin" />
                  Installing...
                </div>
              ) : installState === "error" ? (
                <button
                  onClick={() => setShowContactDialog(true)}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-red-500/10 border border-red-500/20 text-red-300 hover:bg-red-500/15 transition-colors cursor-pointer"
                >
                  <AlertTriangle size={14} />
                  Failed
                </button>
              ) : installState === "installed" ? (
                <div className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-emerald-500/10 border border-emerald-500/20 text-emerald-300">
                  <Check size={14} />
                  Installed
                </div>
              ) : (
                <Switch checked={enabled} onCheckedChange={handleToggle} />
              )}
            </div>
          </div>

          {/* Enabled state info */}
          <AnimatePresence>
            {enabled && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                className="mt-4"
              >
                <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-violet-500/[0.08] border border-violet-500/[0.15]">
                  <Monitor className="size-4 text-violet-400/70 shrink-0" />
                  <p className="text-sm text-violet-300/80">
                    Desktop automation is active. Make sure the{" "}
                    <button
                      onClick={() => setShowDownload(true)}
                      className="underline font-medium text-violet-200 hover:text-white cursor-pointer"
                    >
                      Ampere Desktop app
                    </button>{" "}
                    is running on your computer during automation.
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </Card>
      </section>

      {/* Info Dialog */}
      <AnimatePresence>
        {showDialog && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
          >
            {/* Backdrop */}
            <div
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              onClick={handleDialogClose}
            />

            {/* Dialog */}
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className="relative w-full max-w-lg rounded-2xl border border-white/[0.1] bg-[#0A0A0A] shadow-2xl overflow-hidden"
            >
              {/* Header */}
              <div className="p-6 pb-4">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 rounded-xl bg-violet-500/15 border border-violet-500/25 flex items-center justify-center">
                    <Monitor size={20} className="text-violet-400" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-white">Browser Automation</h3>
                    <span className="uppercase text-[10px] tracking-wider font-semibold bg-violet-500/20 text-violet-300 px-1.5 py-0.5 rounded">
                      Alpha
                    </span>
                  </div>
                </div>
                <p className="text-sm text-white/50 mt-3">
                  Your AI agent can now browse the web on your behalf. Here's how it works:
                </p>
              </div>

              {/* Steps */}
              <div className="px-6 space-y-4">
                {/* Step 1 */}
                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 rounded-lg bg-white/[0.06] border border-white/[0.08] flex items-center justify-center shrink-0">
                    <Download size={14} className="text-white/60" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white">Download the Desktop App</p>
                    <p className="text-xs text-white/40 mt-0.5">
                      Get the Ampere Desktop app for your computer. Available for Mac, Windows, and Linux.
                    </p>
                  </div>
                </div>

                {/* Step 2 */}
                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 rounded-lg bg-white/[0.06] border border-white/[0.08] flex items-center justify-center shrink-0">
                    <Cpu size={14} className="text-white/60" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white">Keep it Running</p>
                    <p className="text-xs text-white/40 mt-0.5">
                      The desktop app must be running while your agent performs browser automation tasks.
                    </p>
                  </div>
                </div>

                {/* Step 3 */}
                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 rounded-lg bg-white/[0.06] border border-white/[0.08] flex items-center justify-center shrink-0">
                    <Globe size={14} className="text-white/60" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white">Your Network, Your Identity</p>
                    <p className="text-xs text-white/40 mt-0.5">
                      Web traffic routes through your desktop's internet connection, making automation look natural and bypass bot detection.
                    </p>
                  </div>
                </div>
              </div>

              {/* Security note */}
              <div className="mx-6 mt-5 px-4 py-3 rounded-xl bg-emerald-500/[0.06] border border-emerald-500/[0.12]">
                <div className="flex items-start gap-2.5">
                  <Shield size={14} className="text-emerald-400/70 mt-0.5 shrink-0" />
                  <p className="text-xs text-emerald-300/70">
                    Your browsing data stays private. The agent only accesses sites you explicitly ask it to — no background browsing or data collection.
                  </p>
                </div>
              </div>

              {/* Actions */}
              <div className="p-6 flex items-center justify-between gap-3">
                <button
                  onClick={() => {
                    setShowDownload(true);
                  }}
                  className="text-sm text-white/40 hover:text-white/60 transition-colors flex items-center gap-1 cursor-pointer"
                >
                  <Download size={14} />
                  Download App
                </button>
                <button
                  onClick={handleDialogConfirm}
                  className="relative bg-white text-black px-5 py-2.5 rounded-xl font-semibold text-sm shadow-[0_3px_0_0_#a0a0a0] hover:translate-y-[1px] hover:shadow-[0_2px_0_0_#a0a0a0] active:translate-y-[3px] active:shadow-none transition-all duration-100 cursor-pointer flex items-center gap-2"
                >
                  Enable Automation
                  <ArrowRight size={14} />
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Contact Support Dialog */}
      <AnimatePresence>
        {showContactDialog && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
          >
            <div
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              onClick={() => setShowContactDialog(false)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className="relative w-full max-w-md rounded-2xl border border-white/[0.1] bg-[#0A0A0A] shadow-2xl overflow-hidden"
            >
              <div className="p-6">
                <button
                  onClick={() => setShowContactDialog(false)}
                  className="absolute top-4 right-4 text-white/30 hover:text-white/60 transition-colors cursor-pointer"
                >
                  <X size={18} />
                </button>

                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-xl bg-red-500/15 border border-red-500/25 flex items-center justify-center">
                    <AlertTriangle size={20} className="text-red-400" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-white">Installation Failed</h3>
                    <p className="text-xs text-white/40">Browser automation couldn&apos;t be installed</p>
                  </div>
                </div>

                <p className="text-sm text-white/50 mb-6">
                  Something went wrong while setting up browser automation. Please contact our team and we&apos;ll get it fixed for you.
                </p>

                <div className="space-y-3">
                  <a
                    href="mailto:support@ampere.sh"
                    className="flex items-center gap-3 w-full px-4 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.06] transition-colors group"
                  >
                    <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0">
                      <Mail size={14} className="text-blue-400" />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-white group-hover:text-white/90">Email Support</p>
                      <p className="text-xs text-white/35">support@ampere.sh</p>
                    </div>
                    <ArrowRight size={14} className="text-white/20 group-hover:text-white/40" />
                  </a>

                  <a
                    href="https://discord.gg/7gpxTkUDF9"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-3 w-full px-4 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.06] transition-colors group"
                  >
                    <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center shrink-0">
                      <MessageCircle size={14} className="text-indigo-400" />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-white group-hover:text-white/90">Discord Community</p>
                      <p className="text-xs text-white/35">Get help from the team</p>
                    </div>
                    <ArrowRight size={14} className="text-white/20 group-hover:text-white/40" />
                  </a>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <SubscriptionDialog open={showSubscription} onClose={() => setShowSubscription(false)} />
      <DownloadDialog open={showDownload} onClose={() => setShowDownload(false)} />
    </>
  );
}
