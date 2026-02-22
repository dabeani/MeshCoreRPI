#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <vector>

class Stream {
public:
	virtual ~Stream() = default;

	virtual int available() { return 0; }
	virtual int read() { return -1; }
	virtual int peek() { return -1; }
	virtual void flush() {}
	virtual int readBytes(uint8_t* dest, int len) {
		int count = 0;
		while (count < len) {
			const int ch = read();
			if (ch < 0) break;
			dest[count++] = static_cast<uint8_t>(ch);
		}
		return count;
	}

	virtual size_t write(const uint8_t* src, size_t len) {
		size_t out = 0;
		for (; out < len; ++out) {
			if (write(src[out]) == 0) break;
		}
		return out;
	}

	virtual size_t write(uint8_t) { return 0; }

	size_t write(const char* s) {
		return s ? write(reinterpret_cast<const uint8_t*>(s), std::strlen(s)) : 0;
	}

	size_t print(const char* s) { return write(s); }
	size_t print(char c) { return write(static_cast<uint8_t>(c)); }

	size_t print(int n) {
		char buf[32];
		std::snprintf(buf, sizeof(buf), "%d", n);
		return write(buf);
	}

	size_t print(unsigned int n) {
		char buf[32];
		std::snprintf(buf, sizeof(buf), "%u", n);
		return write(buf);
	}

	size_t print(long n) {
		char buf[32];
		std::snprintf(buf, sizeof(buf), "%ld", n);
		return write(buf);
	}

	size_t print(unsigned long n) {
		char buf[32];
		std::snprintf(buf, sizeof(buf), "%lu", n);
		return write(buf);
	}

	size_t print(float n) {
		char buf[64];
		std::snprintf(buf, sizeof(buf), "%g", static_cast<double>(n));
		return write(buf);
	}

	size_t println() { return write("\n"); }
	size_t println(const char* s) { return print(s) + println(); }

	template <typename T>
	size_t println(const T& v) {
		return print(v) + println();
	}

	int printf(const char* fmt, ...) {
		va_list args;
		va_start(args, fmt);
		va_list args_copy;
		va_copy(args_copy, args);
		const int needed = std::vsnprintf(nullptr, 0, fmt, args_copy);
		va_end(args_copy);
		if (needed <= 0) {
			va_end(args);
			return needed;
		}

		std::vector<char> buf(static_cast<size_t>(needed) + 1);
		const int n = std::vsnprintf(buf.data(), buf.size(), fmt, args);
		if (n > 0) {
			write(reinterpret_cast<const uint8_t*>(buf.data()), static_cast<size_t>(n));
		}
		va_end(args);
		return n;
	}
};
