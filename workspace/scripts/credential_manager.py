#!/usr/bin/env python3
"""
AAOS Credential Manager
Stores and retrieves credentials using Windows Credential Manager (via keyring).
Credentials are encrypted by Windows DPAPI — never stored in plaintext on disk.

Usage:
  python credential_manager.py get    --service gmail
  python credential_manager.py set    --service gmail --fields '{"email":"a@b.com","password":"secret"}'
  python credential_manager.py delete --service gmail
  python credential_manager.py list
"""
import sys, json, argparse

KEYRING_SERVICE = "AAOS"   # top-level Windows Credential Manager namespace


def _get(service: str) -> dict:
    try:
        import keyring
    except ImportError:
        return {"found": False, "error": "keyring not installed — run: pip install keyring"}

    raw = keyring.get_password(KEYRING_SERVICE, service.lower())
    if raw is None:
        return {"found": False, "service": service}
    try:
        fields = json.loads(raw)
        return {"found": True, "service": service, **fields}
    except Exception as e:
        return {"found": False, "error": f"corrupt credential data: {e}"}


def _set(service: str, fields: dict) -> dict:
    try:
        import keyring
    except ImportError:
        return {"ok": False, "error": "keyring not installed — run: pip install keyring"}

    if not fields:
        return {"ok": False, "error": "No fields provided"}

    # Mask secrets in the log — never print actual values
    safe_keys = list(fields.keys())
    keyring.set_password(KEYRING_SERVICE, service.lower(), json.dumps(fields))
    return {"ok": True, "service": service, "stored_fields": safe_keys}


def _delete(service: str) -> dict:
    try:
        import keyring
        keyring.delete_password(KEYRING_SERVICE, service.lower())
        return {"ok": True, "service": service, "deleted": True}
    except ImportError:
        return {"ok": False, "error": "keyring not installed"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _list() -> dict:
    # keyring doesn't provide a cross-platform list API.
    # On Windows, use the keyring backend to enumerate entries.
    try:
        import keyring
        backend = keyring.get_keyring()
        # Try Windows backend enumeration
        try:
            import keyring.backends.Windows as wb
            import win32cred
            creds = win32cred.CredEnumerate(None, 0) or []
            aaos = [
                c["TargetName"].replace(f"{KEYRING_SERVICE}/", "")
                for c in creds
                if c["TargetName"].startswith(f"{KEYRING_SERVICE}/")
            ]
            return {"services": aaos}
        except Exception:
            pass
        return {"services": [], "note": "Enumeration not available on this backend — use credentials_read to check specific services"}
    except ImportError:
        return {"services": [], "error": "keyring not installed"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="AAOS Credential Manager")
    parser.add_argument("command", choices=["get", "set", "delete", "list"])
    parser.add_argument("--service", default=None, help="Service name (e.g. gmail, outlook)")
    parser.add_argument("--fields", default=None,
                        help='JSON object of credential fields, e.g. {"email":"x","password":"y"}')
    args = parser.parse_args()

    if args.command == "get":
        if not args.service:
            print(json.dumps({"error": "--service required for get"}))
            sys.exit(1)
        print(json.dumps(_get(args.service)))

    elif args.command == "set":
        if not args.service:
            print(json.dumps({"error": "--service required for set"}))
            sys.exit(1)
        try:
            fields = json.loads(args.fields or "{}")
        except Exception as e:
            print(json.dumps({"error": f"Invalid --fields JSON: {e}"}))
            sys.exit(1)
        print(json.dumps(_set(args.service, fields)))

    elif args.command == "delete":
        if not args.service:
            print(json.dumps({"error": "--service required for delete"}))
            sys.exit(1)
        print(json.dumps(_delete(args.service)))

    elif args.command == "list":
        print(json.dumps(_list()))
