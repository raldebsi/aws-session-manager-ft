FROM python:3.12-slim

RUN apt-get update && apt-get install -y curl unzip groff less lsof

RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o aws.zip \
    && unzip aws.zip && ./aws/install && rm -rf aws aws.zip
RUN curl "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb" \
    -o smp.deb && dpkg -i smp.deb && rm smp.deb
RUN curl -LO "https://dl.k8s.io/release/$(curl -sL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
    && install kubectl /usr/local/bin/ && rm kubectl

RUN apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000
CMD ["python", "api/app.py"]
