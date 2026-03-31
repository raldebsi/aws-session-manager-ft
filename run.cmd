@echo off
set IMAGE_NAME=aws-sessions

echo Building image...
docker build -t %IMAGE_NAME% .

docker run --rm -it ^
    -v "%USERPROFILE%\.aws:/root/.aws:ro" ^
    -v "%USERPROFILE%\.kube:/root/.kube" ^
    -v "%cd%\config:/app/config" ^
    -e BIND_ALL=1 ^
    -p 9400-9800:9400-9800 ^
    -p 8000:8000 ^
    %IMAGE_NAME%
