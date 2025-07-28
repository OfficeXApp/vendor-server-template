# --- Builder Stage ---
# This stage is responsible for installing development dependencies and building your application.
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files and install all dependencies (including dev dependencies)
COPY package*.json ./
RUN npm ci

# Copy all source code
COPY . .

# Run your build command. This assumes you have a "build" script in your package.json
# For example, if you're using TypeScript, this might be "tsc" or "npm run build"
# If your project doesn't have a specific build step (e.g., plain JS),
# you might just need to copy the source files here.
# Assuming a common build command for Fastify/Node.js apps:
RUN npm run build

# --- Production Stage ---
# This stage creates the final, lightweight image for deployment.
FROM node:20-slim

# Install curl for healthcheck, sqlite3 for database operations, and python3 for node-gyp
# Ensure these are truly needed in production. If not, remove them to reduce image size.
RUN apt-get update && \
    apt-get install -y curl sqlite3 python3 && \
    rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files (only for production dependencies)
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy built application from the 'builder' stage
COPY --from=builder /app/dist ./dist

# Copy the config directory to the dist folder in the final image
# Ensure src/config exists in your project root relative to the Dockerfile
COPY src/config ./dist/config

# Create data directory structure for your application (e.g., for file uploads)
RUN mkdir -p /data/drives

# Create non-root user for security
RUN groupadd -g 1001 app && \
    useradd -r -u 1001 -g app app && \
    chown -R app:app /app /data

# Switch to non-root user
USER app

# Expose the port your Fastify app listens on
EXPOSE 8888

# Health check (uncomment and adjust if you want to use it)
# HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
#   CMD curl -f http://localhost:8888/health || exit 1

# Command to start the application
CMD ["node", "dist/server.js"]
