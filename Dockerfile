# Railway production image.
# Local development does NOT need Docker: use `npm run dev`.
FROM node:22-bookworm-slim

WORKDIR /app

# Node image does not include Python. ecCodes itself is installed from PyPI.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY requirements.txt ./
RUN python3 -m pip install \
    --no-cache-dir \
    --break-system-packages \
    -r requirements.txt

COPY . .

EXPOSE 8080

CMD ["node", "server.mjs"]
