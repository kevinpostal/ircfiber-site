#!/usr/bin/env python3
"""Emit an InspIRCd `hash="hmac-sha256"` oper password field.

InspIRCd (src/modules/m_password_hash.cpp) stores HMAC passwords as
    base64(salt) "$" base64(HMAC-SHA256(key=salt, msg=password))
and /MKPASSWD picks a random 32-byte salt. We derive the salt
deterministically from a non-secret label so the rendered config is
stable across deploys (no spurious restarts) — a public salt does not
weaken HMAC. Stdlib only, so it runs on the Ansible controller.

Env: INSP_PASSWORD (required), INSP_SALT_LABEL (required).
"""
import base64
import hashlib
import hmac
import os
import sys

password = os.environ.get("INSP_PASSWORD", "")
label = os.environ.get("INSP_SALT_LABEL", "")
if not password or not label:
    sys.stderr.write("INSP_PASSWORD and INSP_SALT_LABEL must be set\n")
    sys.exit(2)

salt = hashlib.sha256(label.encode()).digest()  # 32 bytes = sha256 out_size
digest = hmac.new(salt, password.encode(), hashlib.sha256).digest()
# InspIRCd encodes the salt with '=' padding and the digest without.
sys.stdout.write(base64.b64encode(salt).decode() + "$" + base64.b64encode(digest).decode().rstrip("="))
