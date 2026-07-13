# Fly SSH relay

The public SSH endpoint uses Fly as a raw-TCP relay. The home cluster only makes
an outbound `frpc` connection. The control channel uses a shared random token and
pins a private CA so the client authenticates the Fly relay before sending it.

## Provision TLS and token secrets

Run these commands from a temporary private directory. Do not commit any generated
key, certificate, or token file.

```bash
umask 077

openssl req -x509 -newkey rsa:3072 -sha256 -days 825 -nodes \
  -subj "/CN=xiao-tui internal CA" \
  -keyout ca.key -out ca.crt

openssl req -new -newkey rsa:3072 -sha256 -nodes \
  -subj "/CN=xiao-tui.fly.dev" \
  -keyout server.key -out server.csr

openssl x509 -req -sha256 -days 825 \
  -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -extfile <(printf 'subjectAltName=DNS:xiao-tui.fly.dev\n') \
  -out server.crt
```

Store the server certificate and key as staged Fly secrets. `[[files]]` in
`fly.toml` decodes them into `/etc/frp/tls` during deployment.

```bash
{
  printf 'FRP_SERVER_CERT='
  base64 < server.crt | tr -d '\n'
  printf '\nFRP_SERVER_KEY='
  base64 < server.key | tr -d '\n'
  printf '\n'
} | flyctl secrets import -a xiao-tui --stage
```

Install only the public CA certificate in Kubernetes:

```bash
kubectl -n xiao create secret generic xiao-frp-tls \
  --from-file=ca.crt=ca.crt \
  --dry-run=client -o yaml | kubectl apply -f -
```

Generate and stage a new 256-bit FRP token without placing it in process arguments:

```bash
token="$(openssl rand -hex 32)"
printf 'FRP_TOKEN=%s\n' "$token" | flyctl secrets import -a xiao-tui --stage
printf 'token=%s\n' "$token" | kubectl -n xiao create secret generic xiao-frp \
  --from-env-file=/dev/stdin --dry-run=client -o yaml | kubectl apply -f -
unset token
```

Deploy the relay, then the client. This ordering keeps the old client running
until the relay is ready; expect a brief reconnect while the token changes.

```bash
flyctl deploy fly/
kubectl apply -f k8s/frpc.yaml
kubectl -n xiao rollout status deploy/frpc
```

Delete `ca.key`, `ca.srl`, `server.key`, and `server.csr` from the temporary
directory after provisioning. Keep a protected offline copy of `ca.key` only if
you want to issue a replacement server certificate later.
