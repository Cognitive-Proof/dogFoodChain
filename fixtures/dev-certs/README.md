# Dev/test certs — not for production

Three self-signed ES256 certs, one per reference-implementation role
(`writer`, `confirmer-b`, `confirmer-c`), generated locally with:

```bash
openssl ecparam -name prime256v1 -genkey -noout -out ROLE.tmp.key
openssl pkcs8 -topk8 -nocrypt -in ROLE.tmp.key -out ROLE.key
openssl req -new -x509 -key ROLE.key -out ROLE.pem -days 3650 \
  -subj "/CN=dogfoodchain-dev-ROLE/O=dogFoodChain Dev Test Only" -sha256
```

These are throwaway identities for local testing only — self-signed, no
real-world attestation of who controls them. Do not reuse them for anything
that needs real trust.
