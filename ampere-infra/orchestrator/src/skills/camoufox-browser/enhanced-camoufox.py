#!/usr/bin/env python3
"""Enhanced Camoufox with OAuth popup support"""

import sys
import json
import asyncio
from camoufox.async_api import AsyncCamoufox

async def main():
    if len(sys.argv) < 2:
        print("Usage: enhanced-camoufox.py <command> [args...]", file=sys.stderr)
        sys.exit(1)
        
    command = sys.argv[1]
    
    async with AsyncCamoufox(headless=False, humanize=True) as browser:
        page = await browser.new_page()
        popup_page = None
        
        async def handle_popup(p):
            nonlocal popup_page
            popup_page = p
            print(f"[POPUP] Opened: {p.url}", file=sys.stderr)
        
        page.context.on("page", handle_popup)
        
        try:
            if command == "oauth-login":
                site = sys.argv[2]
                email = sys.argv[3]
                password = sys.argv[4]
                
                if site == "twitter":
                    await page.goto("https://twitter.com", wait_until="domcontentloaded")
                    await asyncio.sleep(3)
                    
                    # Click Sign in with Google
                    async with page.expect_popup() as popup_info:
                        await page.click('div[role="button"]:has-text("Sign in with Google")')
                    
                    popup = await popup_info.value
                    await popup.wait_for_load_state("domcontentloaded")
                    print(f"[OAUTH] Google popup loaded", file=sys.stderr)
                    
                    await asyncio.sleep(2)
                    await popup.fill('input[type="email"]', email)
                    await popup.click('button:has-text("Next")')
                    await asyncio.sleep(4)
                    
                    await popup.fill('input[type="password"]', password)
                    await popup.click('button:has-text("Next")')
                    await asyncio.sleep(15)
                    
                    current_url = page.url
                    if "twitter.com" in current_url or "x.com" in current_url:
                        print(json.dumps({"status": "success", "url": current_url}))
                    else:
                        print(json.dumps({"status": "partial", "message": "May need 2FA"}))
                        
            elif command == "smart-signup":
                site = sys.argv[2]
                data_file = sys.argv[3]
                
                with open(data_file) as f:
                    data = json.load(f)
                    
                if site == "twitter":
                    # Go to signup
                    await page.goto("https://twitter.com", wait_until="domcontentloaded")
                    await asyncio.sleep(3)
                    
                    # Click "Create account"
                    await page.click('a:has-text("Create account")')
                    await asyncio.sleep(3)
                    
                    # Now on signup dialog - find inputs by type
                    inputs = await page.query_selector_all('input[type="text"]')
                    print(f"[INFO] Found {len(inputs)} text inputs", file=sys.stderr)
                    
                    if len(inputs) >= 1:
                        # First input is usually name
                        await inputs[0].fill(data["name"])
                        await inputs[0].press("Tab")
                        await asyncio.sleep(0.5)
                        
                    email_inputs = await page.query_selector_all('input[type="email"]')
                    if len(email_inputs) >= 1:
                        await email_inputs[0].fill(data["email"])
                        await email_inputs[0].press("Tab")
                        await asyncio.sleep(0.5)
                        
                    # Fill birthdate
                    if "birthdate" in data:
                        selects = await page.query_selector_all("select")
                        print(f"[INFO] Found {len(selects)} select dropdowns", file=sys.stderr)
                        
                        if len(selects) >= 3:
                            bd = data["birthdate"]
                            # Month
                            if "month" in bd:
                                await selects[0].select_option(label=bd["month"])
                                await asyncio.sleep(0.3)
                            # Day
                            if "day" in bd:
                                await selects[1].select_option(label=str(bd["day"]))
                                await asyncio.sleep(0.3)
                            # Year
                            if "year" in bd:
                                await selects[2].select_option(label=str(bd["year"]))
                                await asyncio.sleep(0.3)
                                
                    # Click Next
                    next_buttons = await page.query_selector_all('button:has-text("Next")')
                    if next_buttons:
                        await next_buttons[0].click()
                        await asyncio.sleep(5)
                    
                    print(json.dumps({"status": "success", "url": page.url}))
                    
            elif command == "export-cookies":
                output = sys.argv[2]
                cookies = await page.context.cookies()
                
                with open(output, 'w') as f:
                    json.dump(cookies, f, indent=2)
                    
                print(json.dumps({"status": "success", "cookies": len(cookies)}))
                
        except Exception as e:
            print(json.dumps({"status": "error", "message": str(e)}), file=sys.stderr)
            import traceback
            traceback.print_exc()


if __name__ == "__main__":
    asyncio.run(main())
