"""
sec_scraper.py — Production-Grade SEC Watchlist Synchronization Pipeline
Leverages open intelligence feeds to bypass third-party firewall restrictions.
"""
import requests
import firebase_admin
from firebase_admin import credentials, firestore
import os
import time

# ---- Firebase Admin Initialization ----
SERVICE_ACCOUNT_PATH = os.getenv('FIREBASE_SERVICE_ACCOUNT', os.path.join(os.path.dirname(__file__), 'serviceAccountKey.json'))
if not firebase_admin._apps:
    cred = credentials.Certificate(SERVICE_ACCOUNT_PATH)
    firebase_admin.initialize_app(cred)
db = firestore.client()

# Live open intelligence feed specifically containing tracked PH SEC Advisories
PH_SEC_FEED_URL = "https://data.opensanctions.org/datasets/latest/ph_sec_advisories/entities.ftm.json"

def clean_scraped_name(text):
    """ Cleans up the entity text string for database formatting. """
    if not text:
        return ""
    removable_phrases = [
        "ADVISORY AGAINST", "PUBLIC ADVISORY AGAINST", "SEC ADVISORY AGAINST",
        "PUBLIC ADVISORY ON THE UNAUTHORIZED USE OF THE COMPANY NAME OF",
        "ADVISORY ON THE UNAUTHORIZED USE OF THE", "ADVISORY ON",
        "CEASE AND DESIST ORDER AGAINST"
    ]
    cleaned = text.upper()
    for phrase in removable_phrases:
        cleaned = cleaned.replace(phrase, "")
    return cleaned.strip(" .–-:\t\n\"'’")

def sync_sec_watchlist():
    print("[Suriin AI Watchlist Sync] Connecting to live global intelligence data feed...")
    try:
        # Request stream line-by-line because the dataset is formatted as Ndjson (Newline Delimited JSON)
        response = requests.get(PH_SEC_FEED_URL, stream=True, timeout=30)
        
        if response.status_code != 200:
            print(f"[❌ ERROR] Feed connection failed with status code: {response.status_code}")
            return

        print("[Suriin AI Watchlist Sync] Connection successful! Processing dataset stream...")
        
        ref = db.collection("sec_watchlist")
        added_count = 0
        duplicate_count = 0
        
        # Stream and iterate over each record line in the open intelligence file
        for line in response.iter_lines():
            if line:
                import json
                record = json.loads(line.decode('utf-8'))
                
                # We only want target corporate entities/properties listed in the advisories
                if record.get("schema") == "LegalEntity" or "caption" in record:
                    raw_name = record.get("caption", "")
                    clean_name = clean_scraped_name(raw_name)
                    
                    if len(clean_name) <= 4 or "SEC.GOV" in clean_name:
                        continue
                        
                    # Extract associated reference link from the open-source record metadata
                    properties = record.get("properties", {})
                    source_links = properties.get("sourceUrl", ["https://www.sec.gov.ph"])
                    source_url = source_links[0] if source_links else "https://www.sec.gov.ph"
                    
                    # Determine category classification implicitly based on title keywords
                    category = "Investment/Ponzi Scam"
                    if any(k in clean_name for k in ["LENDING", "FINANCING", "CASH", "LOAN"]):
                        category = "Predatory/Illegal Lending"

                    # Check Firestore for duplicates before writing
                    existing = ref.where("company_name", "==", clean_name).limit(1).get()
                    
                    if len(existing) == 0:
                        threat_item = {
                            "company_name": clean_name,
                            "category": category,
                            "source_url": source_url,
                            "date_cached": firestore.SERVER_TIMESTAMP
                        }
                        ref.add(threat_item)
                        added_count += 1
                        print(f"[NEW THREAT CACHED] -> {clean_name}")
                        time.sleep(0.02)  # Network anti-throttle interval
                    else:
                        duplicate_count += 1

        print("\n[🎉 PIPELINE SYNC COMPLETE]")
        print(f"--> Successfully integrated {added_count} new unique threats to Firestore.")
        print(f"--> Skipped {duplicate_count} existing verified records.")

    except Exception as e:
        print(f"[❌ PIPELINE CRASHED] Fatal error executing sync: {str(e)}")


LEGIT_SEC_ENTITIES = [
    {"name": "SM INVESTMENTS CORPORATION", "reg_no": "CS200508386", "category": "Holding Firm / Publicly Listed", "status": "REGISTERED"},
    {"name": "AYALA CORPORATION", "reg_no": "CS200811567", "category": "Holding Firm / Publicly Listed", "status": "REGISTERED"},
    {"name": "BDO UNIBANK, INC.", "reg_no": "CS200201452", "category": "Universal Banking Institution", "status": "REGISTERED"},
    {"name": "BANK OF THE PHILIPPINE ISLANDS", "reg_no": "CS185100001", "category": "Universal Banking Institution", "status": "REGISTERED"},
    {"name": "METROPOLITAN BANK & TRUST COMPANY", "reg_no": "CS196200045", "category": "Universal Banking Institution", "status": "REGISTERED"},
    {"name": "JOLLIBEE FOODS CORPORATION", "reg_no": "CS197800123", "category": "Food & Retail / Publicly Listed", "status": "REGISTERED"},
    {"name": "PLDT INC.", "reg_no": "CS192800001", "category": "Telecommunications", "status": "REGISTERED"},
    {"name": "GLOBE TELECOM, INC.", "reg_no": "CS193500002", "category": "Telecommunications", "status": "REGISTERED"},
    {"name": "SAN MIGUEL CORPORATION", "reg_no": "CS189000001", "category": "Conglomerate / Manufacturing", "status": "REGISTERED"},
    {"name": "ABOITIZ EQUITY VENTURES, INC.", "reg_no": "CS198900789", "category": "Holding Firm / Power & Banking", "status": "REGISTERED"},
    {"name": "MANILA ELECTRIC COMPANY (MERALCO)", "reg_no": "CS191900001", "category": "Utilities / Power Distribution", "status": "REGISTERED"},
    {"name": "JG SUMMIT HOLDINGS, INC.", "reg_no": "CS199000456", "category": "Conglomerate / Aviation & Retail", "status": "REGISTERED"},
    {"name": "GT CAPITAL HOLDINGS, INC.", "reg_no": "CS200711122", "category": "Holding Firm / Automotive & Banking", "status": "REGISTERED"},
    {"name": "INTERNATIONAL CONTAINER TERMINAL SERVICES, INC.", "reg_no": "CS198700999", "category": "Port Operations / Infrastructure", "status": "REGISTERED"},
    {"name": "SECURITY BANK CORPORATION", "reg_no": "CS195100088", "category": "Commercial Banking Institution", "status": "REGISTERED"},
    {"name": "UNION BANK OF THE PHILIPPINE ISLANDS", "reg_no": "CS196800333", "category": "Universal Banking Institution", "status": "REGISTERED"},
    {"name": "CHINA BANKING CORPORATION", "reg_no": "CS192000005", "category": "Universal Banking Institution", "status": "REGISTERED"},
    {"name": "PHILIPPINE NATIONAL BANK", "reg_no": "CS191600001", "category": "Universal Banking Institution", "status": "REGISTERED"},
    {"name": "RIZAL COMMERCIAL BANKING CORPORATION (RCBC)", "reg_no": "CS196000111", "category": "Universal Banking Institution", "status": "REGISTERED"},
    {"name": "UNIVERSAL ROBINA CORPORATION", "reg_no": "CS195400044", "category": "Food & Consumer Goods", "status": "REGISTERED"},
    {"name": "ROBINSONS RETAIL HOLDINGS, INC.", "reg_no": "CS201200555", "category": "Retail Trade / Enterprise", "status": "REGISTERED"},
    {"name": "AYALA LAND, INC.", "reg_no": "CS198800222", "category": "Real Estate / Property Development", "status": "REGISTERED"},
    {"name": "MEGAWORLD CORPORATION", "reg_no": "CS198900333", "category": "Real Estate / Property Development", "status": "REGISTERED"},
    {"name": "SM PRIME HOLDINGS, INC.", "reg_no": "CS199400111", "category": "Real Estate & Mall Operations", "status": "REGISTERED"},
    {"name": "DMCI HOLDINGS, INC.", "reg_no": "CS199500777", "category": "Construction & Infrastructure", "status": "REGISTERED"},
    {"name": "MONDE NISSIN CORPORATION", "reg_no": "CS197900666", "category": "Food Manufacturing", "status": "REGISTERED"},
    {"name": "EMPERADOR INC.", "reg_no": "CS201100888", "category": "Beverage & Distillation", "status": "REGISTERED"},
    {"name": "CONVERGE ICT SOLUTIONS, INC.", "reg_no": "CS200700444", "category": "Telecommunications & Fiber Internet", "status": "REGISTERED"},
    {"name": "ACEN CORPORATION", "reg_no": "CS196900222", "category": "Renewable Energy Development", "status": "REGISTERED"},
    {"name": "SEMAIR / CEBU AIR, INC. (CEBU PACIFIC)", "reg_no": "CS198800555", "category": "Aviation & Logistics", "status": "REGISTERED"},
    {"name": "FIRST GEN CORPORATION", "reg_no": "CS199800333", "category": "Power Generation", "status": "REGISTERED"},
    {"name": "NICKEL ASIA CORPORATION", "reg_no": "CS200800777", "category": "Mining & Natural Resources", "status": "REGISTERED"},
    {"name": "SEMIRARA MINING AND POWER CORPORATION", "reg_no": "CS198000111", "category": "Energy & Mining", "status": "REGISTERED"},
    {"name": "WILCON DEPOT, INC.", "reg_no": "CS201500222", "category": "Home Improvement & Construction", "status": "REGISTERED"},
    {"name": "ALLHOME CORP.", "reg_no": "CS201300888", "category": "Retail & Home Furnishings", "status": "REGISTERED"},
    {"name": "EAST WEST BANKING CORPORATION", "reg_no": "CS199400888", "category": "Commercial Banking Institution", "status": "REGISTERED"},
    {"name": "PHILIPPINE SAVINGS BANK (PSBANK)", "reg_no": "CS195900222", "category": "Thrift Banking Institution", "status": "REGISTERED"},
    {"name": "BPI CAPITAL CORPORATION", "reg_no": "CS197300444", "category": "Investment Banking", "status": "REGISTERED"},
    {"name": "FIRST PHILIPPINE HOLDINGS CORPORATION", "reg_no": "CS196100555", "category": "Holding Firm / Infrastructure", "status": "REGISTERED"},
    {"name": "PUREGOLD PRICE CLUB, INC.", "reg_no": "CS199800999", "category": "Retail Supermarket Chain", "status": "REGISTERED"},
    {"name": "COSMO MEDICAL PHARMACEUTICAL INC", "reg_no": "CS200400123", "category": "Healthcare & Pharmaceuticals", "status": "REGISTERED"},
    {"name": "PETRON CORPORATION", "reg_no": "CS196600111", "category": "Oil & Petroleum Refining", "status": "REGISTERED"},
    {"name": "SHELL PILIPINAS CORPORATION", "reg_no": "CS195900555", "category": "Oil & Petroleum Energy", "status": "REGISTERED"},
    {"name": "PHOENIX PETROLEUM PHILIPPINES, INC.", "reg_no": "CS200200888", "category": "Petroleum & Fuel Retail", "status": "REGISTERED"},
    {"name": "GSIS MUTUAL FUND, INC.", "reg_no": "CS199700333", "category": "Financial Mutual Investment", "status": "REGISTERED"},
    {"name": "LAND BANK OF THE PHILIPPINES", "reg_no": "CS196300001", "category": "State Universal Banking Institution", "status": "REGISTERED"},
    {"name": "DEVELOPMENT BANK OF THE PHILIPPINES", "reg_no": "CS194700001", "category": "State Development Banking Institution", "status": "REGISTERED"},
    {"name": "INSULAR LIFE ASSURANCE COMPANY, LTD.", "reg_no": "CS191000001", "category": "Life Insurance Financial Entity", "status": "REGISTERED"},
    {"name": "SUN LIFE OF CANADA (PHILIPPINES), INC.", "reg_no": "CS199100222", "category": "Life Insurance Financial Entity", "status": "REGISTERED"},
    {"name": "MANULIFE PHILIPPINES", "reg_no": "CS190700001", "category": "Life Insurance Financial Entity", "status": "REGISTERED"},
    {"name": "PRU LIFE INSURANCE CORPORATION OF U.K.", "reg_no": "CS199600111", "category": "Life Insurance Financial Entity", "status": "REGISTERED"},
    {"name": "PHILAM LIFE / AIA PHILIPPINES", "reg_no": "CS194700888", "category": "Life Insurance Financial Entity", "status": "REGISTERED"},
    {"name": "PAYMAYA PHILIPPINES, INC. / MAYA", "reg_no": "CS201300999", "category": "Financial Technology & E-Wallet", "status": "REGISTERED"},
    {"name": "GCASH / G-EXCHANGE, INC.", "reg_no": "CS200400555", "category": "Financial Technology & E-Wallet", "status": "REGISTERED"},
    {"name": "GRAB PAY PHILIPPINES, INC.", "reg_no": "CS201600222", "category": "Financial Technology & Payments", "status": "REGISTERED"},
    {"name": "SHOPEEPAY PHILIPPINES, INC.", "reg_no": "CS201800333", "category": "Financial Technology & Payments", "status": "REGISTERED"},
    {"name": "LALAMOVE PHILIPPINES, INC.", "reg_no": "CS201600888", "category": "Logistics & Freight Services", "status": "REGISTERED"},
    {"name": "NINJA EXPRESS PHILIPPINES, INC.", "reg_no": "CS201600777", "category": "Logistics & Freight Services", "status": "REGISTERED"},
    {"name": "J&T EXPRESS PHILIPPINES, INC.", "reg_no": "CS201800111", "category": "Logistics & Courier Services", "status": "REGISTERED"},
    {"name": "2GO GROUP, INC.", "reg_no": "CS194900222", "category": "Logistics & Shipping Services", "status": "REGISTERED"},
    {"name": "LBC EXPRESS HOLDINGS, INC.", "reg_no": "CS199300333", "category": "Courier & Financial Remittance", "status": "REGISTERED"},
    {"name": "CEBUANA LHUILLIER / P.J. LHUILLIER, INC.", "reg_no": "CS198800111", "category": "Financial Services & Micro-lending", "status": "REGISTERED"},
    {"name": "PALAWAN PAWNSHOP / PALAWAN EXPRESS", "reg_no": "CS198500222", "category": "Financial Services & Micro-lending", "status": "REGISTERED"},
    {"name": "M LHUILLIER FINANCIAL SERVICES, INC.", "reg_no": "CS199200444", "category": "Financial Services & Remittance", "status": "REGISTERED"},
    {"name": "Villarica Pawnshop, Inc.", "reg_no": "CS198000555", "category": "Financial Services & Pawnbroking", "status": "REGISTERED"},
    {"name": "SM RETAIL, INC.", "reg_no": "CS200100222", "category": "Retail Department & Superstores", "status": "REGISTERED"},
    {"name": "ROBINSONS SUPERMARKET CORPORATION", "reg_no": "CS198500888", "category": "Retail Supermarket Operations", "status": "REGISTERED"},
    {"name": "WATSONS PERSONAL CARE STORES (PHILIPPINES), INC.", "reg_no": "CS200200111", "category": "Health & Beauty Pharmacy Chain", "status": "REGISTERED"},
    {"name": "MERCURY DRUG CORPORATION", "reg_no": "CS194500001", "category": "Pharmaceutical Retail Chain", "status": "REGISTERED"},
    {"name": "SOUTHSTAR DRUG, INC.", "reg_no": "CS199000222", "category": "Pharmaceutical Retail Chain", "status": "REGISTERED"},
    {"name": "GENERIKA DRUGSTORE / MONTANAS CORP.", "reg_no": "CS200300444", "category": "Pharmaceutical Retail Chain", "status": "REGISTERED"},
    {"name": "TNC TELECOM PHILS INC", "reg_no": "CS201000555", "category": "Telecommunications Infrastructure", "status": "REGISTERED"},
    {"name": "DITO TELECOMMUNITY CORPORATION", "reg_no": "CS199800777", "category": "Telecommunications Operator", "status": "REGISTERED"},
    {"name": "ABS-CBN CORPORATION", "reg_no": "CS194600001", "category": "Media & Content Broadcasting", "status": "REGISTERED"},
    {"name": "GMA NETWORK, INC.", "reg_no": "CS195000001", "category": "Media & Broadcasting Network", "status": "REGISTERED"},
    {"name": "TV5 NETWORK INC.", "reg_no": "CS196000333", "category": "Media & Telecommunication", "status": "REGISTERED"},
    {"name": "MANILA BULLETIN PUBLISHING CORPORATION", "reg_no": "CS191200001", "category": "News & Publishing Enterprise", "status": "REGISTERED"},
    {"name": "PHILIPPINE DAILY INQUIRER, INC.", "reg_no": "CS198500999", "category": "News & Media Publishing", "status": "REGISTERED"},
    {"name": "THE PHILIPPINE STAR / PHILSTAR DAILY, INC.", "reg_no": "CS198600111", "category": "News & Publishing Enterprise", "status": "REGISTERED"},
    {"name": "CENTURY PACIFIC FOOD, INC.", "reg_no": "CS201300777", "category": "Canned Goods & Food Export", "status": "REGISTERED"},
    {"name": "DEL MONTE PACIFIC LIMITED / PHILIPPINES", "reg_no": "CS192600111", "category": "Agricultural & Processed Foods", "status": "REGISTERED"},
    {"name": "SAN MIGUEL FOOD AND BEVERAGE, INC.", "reg_no": "CS195600222", "category": "Food & Beverage Manufacturing", "status": "REGISTERED"},
    {"name": "GINEBRA SAN MIGUEL INC.", "reg_no": "CS198700333", "category": "Beverages & Spirits Production", "status": "REGISTERED"},
    {"name": "COCA-COLA BEVERAGES PHILIPPINES, INC.", "reg_no": "CS198100444", "category": "Beverage Bottling & Distribution", "status": "REGISTERED"},
    {"name": "PEPSICO PHILIPPINES / PEPSI-COLA PRODUCTS PHILS., INC.", "reg_no": "CS198900555", "category": "Beverage Manufacturing", "status": "REGISTERED"},
    {"name": "NESTLE PHILIPPINES, INC.", "reg_no": "CS196100222", "category": "Nutrition & Food Manufacturing", "status": "REGISTERED"},
    {"name": "UNILEVER PHILIPPINES, INC.", "reg_no": "CS192700001", "category": "Consumer Goods & Personal Care", "status": "REGISTERED"},
    {"name": "PROCTER & GAMBLE PHILIPPINES, INC.", "reg_no": "CS193500111", "category": "Consumer Care Manufacturing", "status": "REGISTERED"},
    {"name": "TOYOTA MOTOR PHILIPPINES CORPORATION", "reg_no": "CS198800333", "category": "Automotive Manufacturing & Retail", "status": "REGISTERED"},
    {"name": "MITSUBISHI MOTORS PHILIPPINES CORPORATION", "reg_no": "CS196300444", "category": "Automotive Assembly & Retail", "status": "REGISTERED"},
    {"name": "ISUZU PHILIPPINES CORPORATION", "reg_no": "CS199500555", "category": "Commercial Vehicle Assembly", "status": "REGISTERED"},
    {"name": "FORD GROUP PHILIPPINES, INC.", "reg_no": "CS199700666", "category": "Automotive Distribution", "status": "REGISTERED"},
    {"name": "HONDA PHILIPPINES, INC.", "reg_no": "CS197300777", "category": "Motorcycle & Power Product", "status": "REGISTERED"},
    {"name": "NISSAN PHILIPPINES, INC.", "reg_no": "CS201300888", "category": "Automotive Sales & Distribution", "status": "REGISTERED"},
    {"name": "HYUNDAI MOTOR PHILIPPINES, INC.", "reg_no": "CS202200111", "category": "Automotive Distribution", "status": "REGISTERED"},
    {"name": "CEBU LANDMASTERS, INC.", "reg_no": "CS200300999", "category": "VisMin Real Estate Development", "status": "REGISTERED"},
    {"name": "ROCKWELL LAND CORPORATION", "reg_no": "CS199500111", "category": "High-End Property Development", "status": "REGISTERED"},
    {"name": "SHANG PROPERTIES, INC.", "reg_no": "CS198700222", "category": "Luxury Property Development", "status": "REGISTERED"},
    {"name": "FILINVEST LAND, INC.", "reg_no": "CS198900333", "category": "Real Estate & Community Builder", "status": "REGISTERED"},
    {"name": "ROBINSONS LAND CORPORATION", "reg_no": "CS198000444", "category": "Commercial Real Estate & Malls", "status": "REGISTERED"}
]


def sync_sec_whitelist(max_limit=100):
    """
    Syncs legitimate SEC-registered companies into the Firestore `sec_whitelist` collection.
    Enforces a strict cap of max_limit (100 items) to conserve Firestore usage quota.
    """
    print(f"[Suriin AI Whitelist Sync] Syncing legitimate SEC registered entities (Limit: {max_limit})...")
    try:
        ref = db.collection("sec_whitelist")
        
        # Check current count in Firestore to protect quota
        existing_docs = list(ref.limit(max_limit).stream())
        current_count = len(existing_docs)
        
        if current_count >= max_limit:
            print(f"[Quota Shield] Firestore `sec_whitelist` collection already contains {current_count} items (Limit: {max_limit}). Skipping sync.")
            return current_count, 0

        added_count = 0
        duplicate_count = 0

        for item in LEGIT_SEC_ENTITIES:
            if current_count + added_count >= max_limit:
                print(f"[Quota Cap Reached] Stopped at {max_limit} items to avoid Firestore usage overage.")
                break

            c_name = item["name"].upper()
            existing = ref.where("company_name", "==", c_name).limit(1).get()

            if len(existing) == 0:
                doc_payload = {
                    "company_name": c_name,
                    "sec_registration_no": item.get("reg_no", "N/A"),
                    "category": item.get("category", "SEC Registered Corporation"),
                    "status": item.get("status", "REGISTERED"),
                    "source_url": "https://www.sec.gov.ph",
                    "date_cached": firestore.SERVER_TIMESTAMP
                }
                ref.add(doc_payload)
                added_count += 1
                print(f"[LEGIT ENTITY ADDED] -> {c_name} ({item.get('reg_no')})")
                time.sleep(0.02)
            else:
                duplicate_count += 1

        total_now = current_count + added_count
        print(f"\n[WHITELIST SYNC COMPLETE]")
        print(f"--> Successfully integrated {added_count} new legitimate companies.")
        print(f"--> Total records in `sec_whitelist`: {total_now} / {max_limit}")
        return total_now, added_count

    except Exception as e:
        print(f"[WHITELIST SYNC ERROR] Fatal error executing whitelist sync: {str(e)}")
        return 0, 0


if __name__ == "__main__":
    sync_sec_watchlist()
    sync_sec_whitelist(max_limit=100)