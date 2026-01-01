# Use official Node.js image
FROM node:20-slim

# Install system dependencies
# python-is-python3 creates the /usr/bin/python symlink properly
RUN apt-get update && apt-get install -y \
    python3 \
    python-is-python3 \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
# This will now succeed because 'python' is available
RUN npm ci

# Copy the rest of the app
COPY . .

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "api/index.js"]
