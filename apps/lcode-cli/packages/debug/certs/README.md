# Debug Network CA Container

The debug server stores its local MITM CA under `certs/network-ca/` by default.

Generated files include `certs/ca.pem`, `keys/ca.private.key`, and host certificates created by `http-mitm-proxy`. They are local development secrets and are ignored by git.
