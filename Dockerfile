# Use Ubuntu base for better compatibility
FROM node:18-bullseye AS base

# Install build dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY proxy/package*.json ./proxy/

# Install dependencies
RUN npm ci --only=production && \
    cd proxy && npm ci --only=production

# Frontend stage - copy static files
FROM base AS frontend

# Copy frontend source
COPY src/ ./src/
COPY index.html ./
COPY favicon.png ./

# Copy frontend to dist
RUN mkdir -p /dist && \
    cp -r src/* index.html favicon.png /dist/

# Production stage
FROM node:18-bullseye AS production

# Install nginx and curl
RUN apt-get update && apt-get install -y \
    nginx \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy Node.js dependencies and proxy code
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/proxy/node_modules ./proxy/node_modules
COPY proxy/ ./proxy/

# Copy nginx configuration
COPY .docker/nginx/nginx.conf /etc/nginx/nginx.conf

# Copy frontend files
COPY --from=frontend /dist /usr/share/nginx/html

# Create startup script
RUN echo '#!/bin/bash' > /start.sh && \
    echo 'set -e' >> /start.sh && \
    echo '' >> /start.sh && \
    echo 'echo "Starting SillyTavern Character Generator..."' >> /start.sh && \
    echo 'echo "Node.js version: $(node --version)"' >> /start.sh && \
    echo 'echo "Nginx version: $(nginx -v 2>&1)"' >> /start.sh && \
    echo '' >> /start.sh && \
    echo '# Test Node.js is available' >> /start.sh && \
    echo 'which node || (echo "ERROR: Node.js not found in PATH"; exit 1)' >> /start.sh && \
    echo '' >> /start.sh && \
    echo '# Start proxy server in background' >> /start.sh && \
    echo 'echo "Starting proxy server..."' >> /start.sh && \
    echo 'cd /app/proxy' >> /start.sh && \
    echo 'NODE_ENV=production node server.js &' >> /start.sh && \
    echo 'PROXY_PID=$!' >> /start.sh && \
    echo 'echo "Proxy server PID: $PROXY_PID"' >> /start.sh && \
    echo '' >> /start.sh && \
    echo '# Wait a moment for proxy to start' >> /start.sh && \
    echo 'sleep 3' >> /start.sh && \
    echo '' >> /start.sh && \
    echo '# Start nginx in background' >> /start.sh && \
    echo 'echo "Starting nginx..."' >> /start.sh && \
    echo 'nginx -g "daemon off;" &' >> /start.sh && \
    echo 'NGINX_PID=$!' >> /start.sh && \
    echo 'echo "Nginx PID: $NGINX_PID"' >> /start.sh && \
    echo '' >> /start.sh && \
    echo '# Function to cleanup processes' >> /start.sh && \
    echo 'cleanup() {' >> /start.sh && \
    echo '    echo "Received termination signal, shutting down..."' >> /start.sh && \
    echo '    kill $PROXY_PID 2>/dev/null || true' >> /start.sh && \
    echo '    kill $NGINX_PID 2>/dev/null || true' >> /start.sh && \
    echo '    wait $PROXY_PID 2>/dev/null || true' >> /start.sh && \
    echo '    wait $NGINX_PID 2>/dev/null || true' >> /start.sh && \
    echo '    echo "All processes stopped"' >> /start.sh && \
    echo '}' >> /start.sh && \
    echo '' >> /start.sh && \
    echo '# Trap signals' >> /start.sh && \
    echo 'trap cleanup TERM INT' >> /start.sh && \
    echo '' >> /start.sh && \
    echo '# Wait for any process to exit' >> /start.sh && \
    echo 'wait' >> /start.sh && \
    chmod +x /start.sh

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:2427/health || exit 1

# Expose port 2427
EXPOSE 2427

# Start the application
CMD ["/start.sh"]
