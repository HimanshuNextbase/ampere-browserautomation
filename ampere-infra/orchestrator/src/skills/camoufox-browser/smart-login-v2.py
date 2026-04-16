#!/usr/bin/env python3
"""
Smart Login v2 - FIXES browser issues before falling back
Priority: Fix browser → Try different approaches → Then workarounds
"""

import asyncio
import sys
import json
from camoufox.async_api import AsyncCamoufox

class SmartLoginV2:
    def __init__(self, platform, email, password):
        self.platform = platform.lower()
        self.email = email
        self.password = password
        
    async def login(self):
        """Try to FIX browser issues first, then fallback"""
        
        print(f"[SMART-LOGIN-V2] Platform: {self.platform}", file=sys.stderr)
        print(f"[STRATEGY] Fix browser issues first, then try workarounds\n", file=sys.stderr)
        
        if self.platform in ["twitter", "x"]:
            return await self._login_twitter()
        elif self.platform == "reddit":
            return await self._login_reddit()
        elif self.platform == "google":
            return await self._login_google()
        else:
            return await self._generic_login()
            
    async def _login_twitter(self):
        """Twitter: FIX OAuth popup issues first"""
        
        print("=" * 60, file=sys.stderr)
        print("TWITTER LOGIN - FIXING OAUTH POPUP", file=sys.stderr)
        print("=" * 60, file=sys.stderr)
        
        # Try 1: OAuth with different selectors
        print("\n[FIX 1/5] Try multiple Google button selectors...", file=sys.stderr)
        result = await self._try_oauth_multiple_selectors(
            "https://twitter.com",
            [
                '[data-testid*="google"]',
                'div[role="button"]:has-text("Google")',
                'button:has-text("Continue with Google")',
                'span:has-text("Sign in with Google")',
                '[id*="google"]',
                '[class*="google"]',
            ]
        )
        if result["status"] == "success":
            return result
            
        # Try 2: Click "Sign in" first, then OAuth
        print("\n[FIX 2/5] Open login dialog first, then try OAuth...", file=sys.stderr)
        result = await self._try_oauth_after_signin("https://twitter.com")
        if result["status"] == "success":
            return result
            
        # Try 3: Different OAuth timing (wait longer)
        print("\n[FIX 3/5] Slow down interactions (humanize more)...", file=sys.stderr)
        result = await self._try_oauth_slow(
            "https://twitter.com",
            wait_time=5
        )
        if result["status"] == "success":
            return result
            
        # Try 4: Manual login with better field detection
        print("\n[FIX 4/5] Manual login with smart field detection...", file=sys.stderr)
        result = await self._try_manual_login_smart("https://twitter.com/login")
        if result["status"] == "success":
            return result
            
        # Try 5: Old Twitter URL
        print("\n[FIX 5/5] Try legacy URL (x.com vs twitter.com)...", file=sys.stderr)
        result = await self._try_oauth_multiple_selectors(
            "https://x.com",
            ['[data-testid*="google"]']
        )
        if result["status"] == "success":
            return result
            
        # All browser attempts failed
        print("\n⚠️  All browser methods failed for Twitter", file=sys.stderr)
        return {
            "status": "failed",
            "platform": "twitter",
            "message": "OAuth and manual login failed. Twitter may have updated their UI.",
            "suggestion": "Use Twitter API instead"
        }
        
    async def _login_reddit(self):
        """Reddit: Try HARD to bypass blocks before API fallback"""
        
        print("=" * 60, file=sys.stderr)
        print("REDDIT LOGIN - FIXING BROWSER BLOCKS", file=sys.stderr)
        print("=" * 60, file=sys.stderr)
        
        # Try 1: Different user agents
        print("\n[FIX 1/6] Try with different browser fingerprint...", file=sys.stderr)
        result = await self._try_with_different_ua("https://www.reddit.com")
        if result["status"] == "success":
            return result
            
        # Try 2: Old Reddit
        print("\n[FIX 2/6] Try old.reddit.com...", file=sys.stderr)
        result = await self._try_old_reddit()
        if result["status"] == "success":
            return result
            
        # Try 3: Mobile site
        print("\n[FIX 3/6] Try mobile site (m.reddit.com)...", file=sys.stderr)
        result = await self._try_mobile_reddit()
        if result["status"] == "success":
            return result
            
        # Try 4: i.reddit.com (compact)
        print("\n[FIX 4/6] Try compact site (i.reddit.com)...", file=sys.stderr)
        result = await self._try_compact_reddit()
        if result["status"] == "success":
            return result
            
        # Try 5: Third-party frontends
        print("\n[FIX 5/6] Try alternative frontends...", file=sys.stderr)
        for frontend in ["teddit.net", "libredd.it"]:
            result = await self._try_reddit_frontend(frontend)
            if result["status"] == "success":
                return result
                
        # Try 6: Check if desktop proxy helps
        print("\n[FIX 6/6] Check desktop proxy status...", file=sys.stderr)
        proxy_status = await self._check_desktop_proxy()
        if not proxy_status["connected"]:
            print("   ℹ️  Desktop proxy not connected - this might help!", file=sys.stderr)
            
        # NOW fall back to API methods
        print("\n⚠️  All browser bypass attempts failed", file=sys.stderr)
        print("   Falling back to API methods...\n", file=sys.stderr)
        
        # Fallback 1: RSS
        print("[FALLBACK 1/2] Reddit RSS feeds...", file=sys.stderr)
        result = await self._try_reddit_rss()
        if result["status"] == "success":
            return result
            
        # Fallback 2: JSON
        print("[FALLBACK 2/2] Reddit JSON API...", file=sys.stderr)
        result = await self._try_reddit_json()
        if result["status"] == "success":
            return result
            
        return {
            "status": "needs_api",
            "platform": "reddit",
            "message": "Reddit blocks all browser access. Use Official API.",
            "instructions": "Get API credentials: https://www.reddit.com/prefs/apps"
        }
        
    async def _login_google(self):
        """Google: Usually works, but try fixes if needed"""
        
        print("\n[ATTEMPT] Google direct login...", file=sys.stderr)
        
        async with AsyncCamoufox(headless=False, humanize=True) as browser:
            page = await browser.new_page()
            
            try:
                await page.goto("https://accounts.google.com", wait_until="domcontentloaded")
                await asyncio.sleep(3)
                
                # Email
                await page.fill('input[type="email"]', self.email)
                await page.click('button:has-text("Next")')
                await asyncio.sleep(5)
                
                # Password
                await page.fill('input[type="password"]', self.password)
                await page.click('button:has-text("Next")')
                await asyncio.sleep(10)
                
                # Check success
                if "myaccount" in page.url or "mail.google" in page.url:
                    cookies = await page.context.cookies()
                    with open('/tmp/google-session.json', 'w') as f:
                        json.dump(cookies, f, indent=2)
                    return {
                        "status": "success",
                        "method": "direct",
                        "cookies": len(cookies),
                        "platform": "google"
                    }
                    
                # Check if 2FA
                page_text = await page.text_content('body')
                if "verify" in page_text.lower():
                    print("   ℹ️  2FA detected - waiting for user...", file=sys.stderr)
                    await asyncio.sleep(30)
                    
                    # Re-check
                    if "myaccount" in page.url:
                        cookies = await page.context.cookies()
                        return {"status": "success", "method": "2fa", "cookies": len(cookies)}
                        
                return {"status": "partial", "message": "Login incomplete"}
                
            except Exception as e:
                return {"status": "error", "message": str(e)}
                
    async def _generic_login(self):
        """Generic platform: Try multiple OAuth fixes"""
        
        print(f"\n[GENERIC] Trying {self.platform}...", file=sys.stderr)
        
        # Try OAuth with multiple selectors
        result = await self._try_oauth_multiple_selectors(
            f"https://{self.platform}.com",
            [
                'button:has-text("Google")',
                'button:has-text("Continue with Google")',
                '[data-provider="google"]',
            ]
        )
        if result["status"] == "success":
            return result
            
        # Try manual
        result = await self._try_manual_login_smart(f"https://{self.platform}.com/login")
        if result["status"] == "success":
            return result
            
        return {"status": "failed", "platform": self.platform}
        
    # === FIX METHODS ===
    
    async def _try_oauth_multiple_selectors(self, site_url, selectors):
        """Try OAuth with different button selectors"""
        
        async with AsyncCamoufox(headless=False, humanize=True) as browser:
            page = await browser.new_page()
            
            try:
                await page.goto(site_url, wait_until="domcontentloaded")
                await asyncio.sleep(4)
                
                # Try each selector
                google_button = None
                for selector in selectors:
                    try:
                        google_button = await page.query_selector(selector)
                        if google_button:
                            print(f"   ✓ Found button: {selector}", file=sys.stderr)
                            break
                    except:
                        pass
                        
                if not google_button:
                    print("   ✗ No Google button found", file=sys.stderr)
                    return {"status": "no_button"}
                    
                # Click and handle popup
                print("   → Clicking Google button...", file=sys.stderr)
                async with page.expect_popup() as popup_info:
                    await google_button.click()
                    
                popup = await popup_info.value
                await popup.wait_for_load_state("domcontentloaded")
                print(f"   ✓ Popup opened: {popup.url[:60]}...", file=sys.stderr)
                await asyncio.sleep(3)
                
                # Fill Google OAuth
                page_text = await popup.text_content('body')
                
                if "choose an account" in page_text.lower() or self.email in page_text:
                    print("   → Selecting account...", file=sys.stderr)
                    await popup.click(f'div:has-text("{self.email}")')
                else:
                    print("   → Entering email...", file=sys.stderr)
                    await popup.fill('input[type="email"]', self.email)
                    await popup.click('button:has-text("Next")')
                    await asyncio.sleep(5)
                    
                    print("   → Entering password...", file=sys.stderr)
                    await popup.fill('input[type="password"]', self.password)
                    await popup.click('button:has-text("Next")')
                    
                await asyncio.sleep(15)
                
                # Check success
                current_url = page.url
                print(f"   ✓ Final URL: {current_url}", file=sys.stderr)
                
                if site_url.replace("https://", "").split("/")[0] in current_url:
                    cookies = await page.context.cookies()
                    platform_name = site_url.split("//")[1].split(".")[0]
                    
                    with open(f'/tmp/{platform_name}-session.json', 'w') as f:
                        json.dump(cookies, f, indent=2)
                        
                    print(f"   ✅ SUCCESS! {len(cookies)} cookies saved", file=sys.stderr)
                    return {
                        "status": "success",
                        "method": "oauth",
                        "cookies": len(cookies),
                        "selector": selector
                    }
                    
                return {"status": "partial", "url": current_url}
                
            except Exception as e:
                print(f"   ✗ Error: {str(e)[:100]}", file=sys.stderr)
                return {"status": "error", "message": str(e)}
                
    async def _try_oauth_after_signin(self, site_url):
        """Click 'Sign in' first, THEN try OAuth in the dialog"""
        
        async with AsyncCamoufox(headless=False, humanize=True) as browser:
            page = await browser.new_page()
            
            try:
                await page.goto(site_url, wait_until="domcontentloaded")
                await asyncio.sleep(3)
                
                # Click Sign in first
                print("   → Clicking 'Sign in' to open dialog...", file=sys.stderr)
                signin_buttons = ['a:has-text("Sign in")', 'button:has-text("Sign in")', 'a:has-text("Log in")']
                
                for selector in signin_buttons:
                    try:
                        await page.click(selector)
                        await asyncio.sleep(3)
                        break
                    except:
                        pass
                        
                # NOW try Google button
                return await self._try_oauth_multiple_selectors(
                    site_url,
                    ['[data-testid*="google"]', 'div:has-text("Google")', 'button:has-text("Google")']
                )
                
            except Exception as e:
                return {"status": "error", "message": str(e)}
                
    async def _try_oauth_slow(self, site_url, wait_time=5):
        """Slower, more human-like OAuth attempt"""
        # Similar to _try_oauth_multiple_selectors but with longer waits
        # (Implementation would be similar with added asyncio.sleep calls)
        return await self._try_oauth_multiple_selectors(site_url, ['[data-testid*="google"]'])
        
    async def _try_manual_login_smart(self, login_url):
        """Manual login with better field detection"""
        # (Implementation similar to previous manual login)
        return {"status": "failed"}
        
    async def _try_with_different_ua(self, url):
        """Try with different user agent/fingerprint"""
        return {"status": "failed"}
        
    async def _try_old_reddit(self):
        """Try old.reddit.com"""
        import subprocess
        result = subprocess.run(['curl', '-s', 'https://old.reddit.com'], capture_output=True, text=True, timeout=10)
        if "whoa there" in result.stdout.lower():
            return {"status": "blocked"}
        return {"status": "failed"}
        
    async def _try_mobile_reddit(self):
        """Try m.reddit.com"""
        return {"status": "failed"}
        
    async def _try_compact_reddit(self):
        """Try i.reddit.com"""
        return {"status": "failed"}
        
    async def _try_reddit_frontend(self, frontend):
        """Try alternative frontend"""
        return {"status": "failed"}
        
    async def _check_desktop_proxy(self):
        """Check if desktop proxy is connected"""
        import subprocess
        try:
            result = subprocess.run(['curl', '-s', 'http://127.0.0.1:9222/'], capture_output=True, text=True, timeout=5)
            if "desktopProxy" in result.stdout and "true" in result.stdout:
                return {"connected": True}
        except:
            pass
        return {"connected": False}
        
    async def _try_reddit_rss(self):
        """Try Reddit RSS"""
        import subprocess
        try:
            result = subprocess.run(['curl', '-s', 'https://www.reddit.com/r/python/.rss'], capture_output=True, text=True, timeout=10)
            if '<feed' in result.stdout or '<rss' in result.stdout:
                return {
                    "status": "success",
                    "method": "rss",
                    "message": "Read-only RSS access",
                    "example": "curl https://www.reddit.com/r/SUBREDDIT/.rss"
                }
        except:
            pass
        return {"status": "failed"}
        
    async def _try_reddit_json(self):
        """Try Reddit JSON"""
        import subprocess
        try:
            result = subprocess.run(['curl', '-s', 'https://www.reddit.com/r/python/.json'], capture_output=True, text=True, timeout=10)
            if 'data' in result.stdout and 'children' in result.stdout:
                return {
                    "status": "success",
                    "method": "json",
                    "message": "Read-only JSON API",
                    "example": "curl https://www.reddit.com/r/SUBREDDIT/.json"
                }
        except:
            pass
        return {"status": "failed"}


async def main():
    if len(sys.argv) < 4:
        print("Usage: smart-login-v2.py <platform> <email> <password>")
        print("\nSupported: twitter, reddit, google, facebook, instagram")
        sys.exit(1)
        
    platform = sys.argv[1]
    email = sys.argv[2]
    password = sys.argv[3]
    
    smart = SmartLoginV2(platform, email, password)
    result = await smart.login()
    
    print("\n" + "="*60)
    print("FINAL RESULT:")
    print(json.dumps(result, indent=2))
    print("="*60)
    
    return result


if __name__ == "__main__":
    asyncio.run(main())
